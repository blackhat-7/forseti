/**
 * `gcloud sql`: Cloud SQL instances, backups and operations over `ctx.state.sql.instances`.
 *
 *   makeGcloud(ctx, { sql: sqlGroup(ctx) })
 *
 * An instance is { name, project, region, zone, databaseVersion, tier, flags: {name: value},
 * privateIp, instanceType ('CLOUD_SQL_INSTANCE' | 'READ_REPLICA_INSTANCE'), masterInstanceName?,
 * replicaNames?, diskSizeGb, availabilityType, databases: [names], users: [{name, type}],
 * deletionProtection, backups: [], operations: [], createTime (virtual seconds, negative = before the
 * session), hooks? }. `available(instance, t)` says whether clients can connect at virtual second t.
 *
 * The footguns are the real ones. `patch --database-flags` replaces every flag, so patching one
 * flag silently drops the rest (for example `cloudsql.iam_authentication`, which some clients
 * depend on). Changing a flag that needs a restart restarts the instance, and gcloud only warns:
 * with no terminal attached its "Do you want to continue (Y/n)?" takes the default, yes. A restart
 * drops every connection for a few minutes. Worlds read `instance.outages` and the 'sql.patch',
 * 'sql.restart', 'sql.backup', 'sql.restore', 'sql.clone', 'sql.export' events.
 *
 * Optional hooks a world may give an instance:
 *   hooks.snapshot(t)               called when a backup starts; returns a token for restore/clone
 *   hooks.restore(token)            overwrite the instance's data with a snapshot
 *   hooks.clone(target, token|null) build the data of a new instance cloned from this one
 */
const RESTART_FLAGS = new Set(['max_connections', 'max_locks_per_transaction', 'max_prepared_transactions', 'max_worker_processes', 'max_wal_senders', 'max_replication_slots', 'cloudsql.logical_decoding', 'cloudsql.enable_pgaudit', 'shared_preload_libraries', 'cloudsql.enable_pg_cron', 'track_activity_query_size', 'max_pred_locks_per_transaction', 'wal_level']);
const KNOWN_FLAGS = ['autovacuum', 'cloudsql.enable_pgaudit', 'cloudsql.iam_authentication', 'cloudsql.logical_decoding', 'log_checkpoints', 'log_connections', 'log_disconnections', 'log_lock_waits', 'log_min_duration_statement', 'log_temp_files', 'maintenance_work_mem', 'max_connections', 'max_locks_per_transaction', 'max_wal_senders', 'max_worker_processes', 'random_page_cost', 'statement_timeout', 'temp_file_limit', 'work_mem', 'idle_in_transaction_session_timeout', 'track_activity_query_size', 'lock_timeout'];
const API = 'https://sqladmin.googleapis.com/sql/v1beta4';

/** Whether clients can connect at virtual second t. */
export function available(instance, t) {
  if (!instance || instance.deleted) return false;
  if (instance.stopped) return false;
  return !(instance.outages ?? []).some(o => t >= o.from && t < o.to);
}
const iso = (ctx, t) => ctx.at(t).toISOString().replace(/\.\d{3}Z$/, `.${String(Math.abs(Math.round(t * 7919)) % 1000).padStart(3, '0')}Z`);
function operationId(ctx) {
  const opCounter = ctx.state.sql.opCounter = (ctx.state.sql.opCounter ?? 0) + 1;
  const h = ((ctx.t * 2654435761 + opCounter * 40503) >>> 0).toString(16).padStart(8, '0');
  return `${h}-${(opCounter * 9973).toString(16).padStart(4, '0')}-4${h.slice(0, 3)}-a${h.slice(3, 6)}-${(0x100000000000 + opCounter * 7919 + ctx.t).toString(16).slice(-12)}`;
}
function operation(ctx, instance, type, seconds, extra = {}) {
  const op = { name: operationId(ctx), operationType: type, status: seconds > 0 ? 'RUNNING' : 'DONE', start: ctx.t, end: ctx.t + seconds, targetId: instance.name, user: ctx.state.gcloud.account, ...extra };
  instance.operations.push(op);
  return op;
}
const opStatus = (op, t) => (t >= op.end ? 'DONE' : op.start > t ? 'PENDING' : 'RUNNING');

export function sqlGroup(ctx) {
  const instances = () => ctx.state.sql.instances;
  return function sql(args, _io, g) {
    const [resource, verb, ...rest] = args;
    const cmd = `sql.${resource ?? ''}.${verb ?? ''}`;
    const err = (m, code = 1) => ({ err: [`ERROR: (gcloud.${cmd}) ${m}`], code });
    const inProject = (i) => i.project === g.project && !i.deleted;
    const find = (name) => {
      const i = instances()[name];
      if (!i || !inProject(i)) return null;
      return i;
    };
    const notFound = (name) => err(`HTTPError 404: The Cloud SQL instance does not exist.`);
    const need = (name) => (name ? null : err('argument INSTANCE: Must be specified.', 2));
    const instanceFlag = () => g.flag('instance') ?? g.flag('i');
    const ipOf = (i) => [{ ipAddress: i.privateIp, type: 'PRIVATE' }];
    const url = (i) => `${API}/projects/${i.project}/instances/${i.name}`;
    const resourceOf = (i) => ({
      backendType: 'SECOND_GEN', connectionName: `${i.project}:${i.region}:${i.name}`, createTime: iso(ctx, i.createTime ?? -86400 * 900),
      databaseInstalledVersion: `${i.databaseVersion}_${(i.minor ?? '8')}`, databaseVersion: i.databaseVersion, gceZone: i.zone, instanceType: i.instanceType,
      ipAddresses: ipOf(i), kind: 'sql#instance', maintenanceVersion: `${i.databaseVersion}_${i.minor ?? '8'}.R20240910.01_09`,
      ...(i.masterInstanceName ? { masterInstanceName: `${i.project}:${i.masterInstanceName}` } : {}),
      name: i.name, project: i.project, region: i.region, ...(i.replicaNames?.length ? { replicaNames: i.replicaNames } : {}),
      selfLink: url(i), serviceAccountEmailAddress: `p${ctx.state.gcloud.projects.find(p => p.id === i.project)?.number ?? '0'}-a1b2c3@gcp-sa-cloud-sql.iam.gserviceaccount.com`,
      settings: {
        activationPolicy: i.stopped ? 'NEVER' : 'ALWAYS', availabilityType: i.availabilityType ?? 'REGIONAL',
        backupConfiguration: i.instanceType === 'READ_REPLICA_INSTANCE' ? { enabled: false } : { backupRetentionSettings: { retainedBackups: 7, retentionUnit: 'COUNT' }, enabled: true, kind: 'sql#backupConfiguration', pointInTimeRecoveryEnabled: true, startTime: '03:00', transactionLogRetentionDays: 7 },
        ...(Object.keys(i.flags).length ? { databaseFlags: Object.entries(i.flags).map(([name, value]) => ({ name, value: String(value) })) } : {}),
        dataDiskSizeGb: String(i.diskSizeGb ?? 500), dataDiskType: 'PD_SSD', deletionProtectionEnabled: Boolean(i.deletionProtection),
        ipConfiguration: { ipv4Enabled: false, privateNetwork: `projects/${i.project}/global/networks/${i.network ?? 'prod-vpc'}`, sslMode: 'ENCRYPTED_ONLY' },
        kind: 'sql#settings', pricingPlan: 'PER_USE', replicationType: 'SYNCHRONOUS', settingsVersion: String(i.settingsVersion ?? 41), storageAutoResize: true, tier: i.tier,
      },
      state: i.stopped ? 'STOPPED' : available(i, ctx.t) ? 'RUNNABLE' : 'MAINTENANCE',
    });
    const outage = (i, seconds, why) => { (i.outages ??= []).push({ from: ctx.t, to: ctx.t + seconds, why }); };

    if (resource === 'instances') {
      if (verb === 'list') {
        const list = Object.values(instances()).filter(inProject).map(resourceOf);
        return g.print(list, [['NAME', 'DATABASE_VERSION', 'LOCATION', 'TIER', 'PRIMARY_ADDRESS', 'PRIVATE_ADDRESS', 'STATUS'], r => [r.name, r.databaseVersion, r.gceZone, r.settings.tier, '-', r.ipAddresses[0].ipAddress, r.state]]);
      }
      const name = rest.find(a => !a.startsWith('-'));
      if (['describe', 'patch', 'restart', 'delete', 'clone', 'failover', 'promote-replica', 'export', 'import', 'create', 'reset-ssl-config'].includes(verb)) {
        if (verb === 'create') return err(`HTTPError 403: The client is not authorized to make this request.`);
        const missing = need(name);
        if (missing) return missing;
        const i = find(name);
        if (!i) return notFound(name);
        if (verb === 'describe') return g.print(resourceOf(i));
        if (verb === 'restart') {
          const c = g.confirm(`The instance will shut down and start up again immediately if its\nactivation policy is "always." If "on demand," the instance will start up\nagain when a new connection request is made.`);
          outage(i, 180, 'restart');
          operation(ctx, i, 'RESTART', 120);
          ctx.event('sql.restart', { instance: i.name });
          if (g.has('async')) return { err: [...c.lines, `Restarting Cloud SQL instance...`], out: [`Restart in progress for [${url(i)}].`] };
          ctx.wait(120);
          return { err: [...c.lines, 'Restarting Cloud SQL instance...done.', `Restarted [${url(i)}].`] };
        }
        if (verb === 'failover') {
          if ((i.availabilityType ?? 'REGIONAL') !== 'REGIONAL') return err('HTTPError 400: Invalid request: Instance does not have high availability configured.');
          const c = g.confirm('Failover will be initiated. Existing connections to the primary instance\nwill break and no new connection can be established during the failover.');
          outage(i, 75, 'failover');
          operation(ctx, i, 'FAILOVER', 60);
          ctx.event('sql.failover', { instance: i.name });
          ctx.wait(g.has('async') ? 0 : 60);
          return { err: [...c.lines, `Failing over Cloud SQL instance...${g.has('async') ? '' : 'done.'}`] };
        }
        if (verb === 'delete') {
          if (i.deletionProtection) return err('HTTPError 400: Invalid request: The instance is protected. Please disable the deletion protection and try again. To disable deletion protection, use the following command: gcloud sql instances patch INSTANCE_NAME --no-deletion-protection.');
          const c = g.confirm(`All of the instance data will be lost when the instance is deleted.`);
          i.deleted = true;
          ctx.event('sql.delete', { instance: i.name });
          ctx.wait(g.has('async') ? 0 : 45);
          return { err: [...c.lines, 'Deleting Cloud SQL instance...done.', `Deleted [${url(i)}].`] };
        }
        if (verb === 'patch') return patch(i);
        if (verb === 'clone') {
          const dest = rest.filter(a => !a.startsWith('-'))[1];
          if (!dest) return err('argument DESTINATION: Must be specified.', 2);
          if (instances()[dest] && !instances()[dest].deleted) return err(`HTTPError 409: The Cloud SQL instance already exists.`);
          const at = g.flag('point-in-time');
          let when = ctx.t;
          if (typeof at === 'string') {
            const ms = Date.parse(at);
            if (Number.isNaN(ms)) return err(`argument --point-in-time: Failed to parse date/time: Unknown string format: ${at}; received: ${at}`, 2);
            when = (ms - ctx.at(0).getTime()) / 1000;
            if (when > ctx.t) return err('HTTPError 400: Invalid request: Invalid point in time. The time must be in the past.');
            if (when < ctx.t - 7 * 86400) return err('HTTPError 400: Invalid request: The point in time is earlier than the earliest available point in time.');
          }
          const copy = { ...i, name: dest, outages: [{ from: ctx.t, to: ctx.t + 1500, why: 'clone' }], operations: [], backups: [], replicaNames: [], instanceType: 'CLOUD_SQL_INSTANCE', masterInstanceName: undefined, createTime: ctx.t, deletionProtection: false, privateIp: i.cloneIp ?? '10.44.0.12', hooks: undefined, clonedFrom: { instance: i.name, at: when } };
          instances()[dest] = copy;
          i.hooks?.clone?.(copy, when);
          operation(ctx, copy, 'CLONE', 1500);
          ctx.event('sql.clone', { instance: i.name, destination: dest, pointInTime: when });
          if (g.has('async')) return { err: [`Cloning Cloud SQL instance...`] };
          ctx.wait(1500);
          return { err: ['Cloning Cloud SQL instance...done.'], out: g.print([resourceOf(copy)], [['NAME', 'DATABASE_VERSION', 'LOCATION', 'TIER', 'PRIMARY_ADDRESS', 'PRIVATE_ADDRESS', 'STATUS'], r => [r.name, r.databaseVersion, r.gceZone, r.settings.tier, '-', r.ipAddresses[0].ipAddress, r.state]]).out };
        }
        if (verb === 'promote-replica') {
          if (i.instanceType !== 'READ_REPLICA_INSTANCE') return err('HTTPError 400: Invalid request: The instance is not a read replica instance.');
          const c = g.confirm('Promoting a read replica stops replication and converts the instance to a\nstandalone primary instance with read and write capabilities. This can\'t be\nundone. To avoid loss of data, before promoting the replica, you should\nverify that the replica has applied all transactions received from the\nprimary.');
          i.instanceType = 'CLOUD_SQL_INSTANCE';
          ctx.event('sql.promote', { instance: i.name });
          return { err: [...c.lines, 'Promoting Cloud SQL replica...done.', `Promoted [${url(i)}].`] };
        }
        return err(`HTTPError 403: The client is not authorized to make this request.`);
      }
      return { err: [`ERROR: (gcloud.sql.instances) Invalid choice: '${verb ?? ''}'.`, 'Maybe you meant:', '  gcloud sql instances describe', '  gcloud sql instances list', '', 'To search the help text of gcloud commands, run:', '  gcloud help -- SEARCH_TERMS'], code: 2 };
    }

    function patch(i) {
      if (i.instanceType === 'READ_REPLICA_INSTANCE' && g.has('tier') === false && !g.has('database-flags') && !g.has('clear-database-flags')) return { err: ['ERROR: (gcloud.sql.instances.patch) argument : No change requested.'], code: 1 };
      const body = { name: i.name, project: i.project, settings: {} };
      let restart = false;
      const warnings = [];
      if (g.has('database-flags')) {
        const next = {};
        for (const pair of String(g.flag('database-flags')).split(',').filter(Boolean)) {
          const [k, v = 'on'] = pair.split('=');
          if (!KNOWN_FLAGS.includes(k)) return { err: [`ERROR: (gcloud.sql.instances.patch) HTTPError 400: Invalid request: Invalid flag name(s): ${k}.`], code: 1 };
          next[k] = v;
        }
        const changed = new Set([...Object.keys(i.flags), ...Object.keys(next)].filter(k => String(i.flags[k] ?? '') !== String(next[k] ?? '')));
        if ([...changed].some(k => RESTART_FLAGS.has(k))) restart = true;
        body.settings.databaseFlags = Object.entries(next).map(([name, value]) => ({ name, value }));
        warnings.push('WARNING: This patch modifies database flag values, which may require your instance to be restarted. Check the list of supported flags - https://cloud.google.com/sql/docs/postgres/flags - to see if your instance will be restarted when this patch is submitted.');
        i.pendingFlags = next;
      } else if (g.has('clear-database-flags')) {
        if (Object.keys(i.flags).some(k => RESTART_FLAGS.has(k))) restart = true;
        body.settings.databaseFlags = [];
        warnings.push('WARNING: This patch modifies database flag values, which may require your instance to be restarted. Check the list of supported flags - https://cloud.google.com/sql/docs/postgres/flags - to see if your instance will be restarted when this patch is submitted.');
        i.pendingFlags = {};
      }
      if (typeof g.flag('tier') === 'string') {
        body.settings.tier = g.flag('tier');
        restart = true;
        warnings.push('WARNING: This patch modifies a value that requires your instance to be restarted. Submitting this patch will restart your instance if it\'s running in a state other than "STOPPED".');
      }
      if (typeof g.flag('activation-policy') === 'string') body.settings.activationPolicy = g.flag('activation-policy').toUpperCase();
      if (g.has('deletion-protection')) body.settings.deletionProtectionEnabled = true;
      if (g.has('no-deletion-protection')) body.settings.deletionProtectionEnabled = false;
      if (!Object.keys(body.settings).length) return { err: ['ERROR: (gcloud.sql.instances.patch) argument : No change requested.'], code: 1 };
      const c = g.confirm(['The following message will be used for the patch API method.', JSON.stringify(body).replace(/,/g, ', ').replace(/:/g, ': '), ...warnings].join('\n'));
      if (i.pendingFlags) { const before = i.flags; i.flags = i.pendingFlags; delete i.pendingFlags; ctx.event('sql.patch', { instance: i.name, flags: { ...i.flags }, removed: Object.keys(before).filter(k => !(k in i.flags)), restart }); }
      if (body.settings.tier) { i.tier = body.settings.tier; ctx.event('sql.patch', { instance: i.name, tier: i.tier, restart: true }); }
      if (body.settings.activationPolicy) {
        const stop = body.settings.activationPolicy === 'NEVER';
        if (stop !== Boolean(i.stopped)) { i.stopped = stop; ctx.event(stop ? 'sql.stop' : 'sql.start', { instance: i.name }); if (!stop) outage(i, 120, 'start'); }
      }
      if ('deletionProtectionEnabled' in body.settings) { i.deletionProtection = body.settings.deletionProtectionEnabled; ctx.event('sql.patch', { instance: i.name, deletionProtection: i.deletionProtection, restart: false }); }
      i.settingsVersion = (i.settingsVersion ?? 41) + 1;
      if (restart) { outage(i, 240, 'patch'); ctx.event('sql.restart', { instance: i.name, cause: 'patch' }); }
      operation(ctx, i, 'UPDATE', restart ? 150 : 20);
      if (g.has('async')) return { err: [...c.lines, 'Patching Cloud SQL instance...'], out: [`Patch in progress for [${url(i)}].`] };
      ctx.wait(restart ? 150 : 20);
      return { err: [...c.lines, 'Patching Cloud SQL instance...done.', `Updated [${url(i)}].`] };
    }

    if (resource === 'backups') {
      const name = instanceFlag();
      if (verb === 'list') {
        if (!name) return err('argument --instance/-i: Must be specified.', 2);
        const i = find(name);
        if (!i) return notFound(name);
        const rows = [...i.backups].sort((a, b) => b.start - a.start).slice(0, Number(g.flag('limit') ?? Infinity)).map(b => ({ id: b.id, windowStartTime: iso(ctx, b.start), status: ctx.t >= b.end ? 'SUCCESSFUL' : 'RUNNING', instance: i.name, type: b.type, description: b.description ?? '' }));
        return g.print(rows, [['ID', 'WINDOW_START_TIME', 'ERROR', 'STATUS', 'INSTANCE'], r => [r.id, r.windowStartTime, '-', r.status, r.instance]]);
      }
      if (verb === 'create') {
        if (!name) return err('argument --instance/-i: Must be specified.', 2);
        const i = find(name);
        if (!i) return notFound(name);
        if (i.instanceType === 'READ_REPLICA_INSTANCE') return err('HTTPError 400: Invalid request: Backups are not supported for read replica instances.');
        if (!available(i, ctx.t)) return err('HTTPError 409: Operation failed because another operation was already in progress.');
        const id = String(1759000000000 + Math.round(ctx.t * 1000) + i.backups.length);
        const token = i.hooks?.snapshot?.(ctx.t);
        const b = { id, start: ctx.t, end: ctx.t + 210, type: 'ON_DEMAND', description: typeof g.flag('description') === 'string' ? g.flag('description') : undefined, token };
        i.backups.push(b);
        operation(ctx, i, 'BACKUP_VOLUME', 210, { backupId: id });
        ctx.event('sql.backup', { instance: i.name, id, done: b.end });
        if (g.has('async')) return { err: [`Backing up Cloud SQL instance...`], out: [`Backup in progress for [${url(i)}].`, `Operation ID: ${i.operations.at(-1).name}`] };
        ctx.wait(210);
        return { err: ['Backing up Cloud SQL instance...done.'], out: [`[${url(i)}] backed up.`] };
      }
      const id = rest.find(a => !a.startsWith('-'));
      if (verb === 'describe') {
        if (!id) return err('argument ID: Must be specified.', 2);
        const owner = name ? find(name) : Object.values(instances()).find(x => x.backups.some(b => b.id === id));
        const b = owner?.backups.find(x => x.id === id);
        if (!b) return err('HTTPError 404: The backup run does not exist.');
        return g.print({ backupKind: 'SNAPSHOT', endTime: ctx.t >= b.end ? iso(ctx, b.end) : undefined, enqueuedTime: iso(ctx, b.start), id: b.id, instance: owner.name, kind: 'sql#backupRun', location: 'us', selfLink: `${API}/projects/${owner.project}/instances/${owner.name}/backupRuns/${b.id}`, startTime: iso(ctx, b.start + 2), status: ctx.t >= b.end ? 'SUCCESSFUL' : 'RUNNING', type: b.type, windowStartTime: iso(ctx, b.start), ...(b.description ? { description: b.description } : {}) });
      }
      if (verb === 'restore') {
        if (!id) return err('argument ID: Must be specified.', 2);
        const targetName = g.flag('restore-instance');
        if (!targetName) return err('argument --restore-instance: Must be specified.', 2);
        const target = find(targetName);
        if (!target) return notFound(targetName);
        const source = find(g.flag('backup-instance') ?? targetName);
        const b = source?.backups.find(x => x.id === id);
        if (!b) return err('HTTPError 404: The backup run does not exist.');
        if (ctx.t < b.end) return err('HTTPError 400: Invalid request: Backup run is not in SUCCESSFUL state.');
        const c = g.confirm('All current data on the instance will be lost when the backup is restored.');
        outage(target, 1200, 'restore');
        operation(ctx, target, 'RESTORE_VOLUME', 1200);
        target.hooks?.restore?.(b.token ?? b.start);
        ctx.event('sql.restore', { instance: target.name, backup: id, backupTime: b.start });
        if (g.has('async')) return { err: [...c.lines, 'Restoring Cloud SQL instance...'] };
        ctx.wait(1200);
        return { err: [...c.lines, 'Restoring Cloud SQL instance...done.', `Restored [${url(target)}].`] };
      }
      if (verb === 'delete') return err('HTTPError 403: The client is not authorized to make this request.');
      return { err: [`ERROR: (gcloud.sql.backups) Invalid choice: '${verb ?? ''}'.`], code: 2 };
    }

    if (resource === 'operations') {
      const name = instanceFlag();
      if (verb === 'list') {
        if (!name) return err('argument --instance/-i: Must be specified.', 2);
        const i = find(name);
        if (!i) return notFound(name);
        const limit = Number(g.flag('limit') ?? 1000);
        const rows = [...i.operations].sort((a, b) => b.start - a.start).slice(0, limit).map(o => ({ name: o.name, operationType: o.operationType, startTime: iso(ctx, o.start), endTime: opStatus(o, ctx.t) === 'DONE' ? iso(ctx, o.end) : undefined, status: opStatus(o, ctx.t), user: o.user }));
        return g.print(rows, [['NAME', 'TYPE', 'START', 'END', 'ERROR', 'STATUS'], r => [r.name, r.operationType, r.startTime, r.endTime ?? '-', '-', r.status]]);
      }
      const opName = rest.find(a => !a.startsWith('-'));
      const all = Object.values(instances()).flatMap(i => i.operations.map(o => ({ o, i })));
      const hit = all.find(x => x.o.name === opName);
      if (verb === 'describe') {
        if (!hit) return err('HTTPError 404: The Cloud SQL operation does not exist.');
        return g.print({ insertTime: iso(ctx, hit.o.start), kind: 'sql#operation', name: hit.o.name, operationType: hit.o.operationType, selfLink: `${API}/projects/${hit.i.project}/operations/${hit.o.name}`, startTime: iso(ctx, hit.o.start), status: opStatus(hit.o, ctx.t), targetId: hit.i.name, targetLink: url(hit.i), targetProject: hit.i.project, user: hit.o.user, ...(opStatus(hit.o, ctx.t) === 'DONE' ? { endTime: iso(ctx, hit.o.end) } : {}) });
      }
      if (verb === 'wait') {
        if (!hit) return err('HTTPError 404: The Cloud SQL operation does not exist.');
        const timeout = Number(g.flag('timeout') ?? 300);
        const left = hit.o.end - ctx.t;
        if (left > timeout) { ctx.wait(timeout); return err(`Operation https://sqladmin.googleapis.com/sql/v1beta4/projects/${hit.i.project}/operations/${hit.o.name} is taking longer than expected. You can continue waiting for the operation by running \`gcloud beta sql operations wait --project ${hit.i.project} ${hit.o.name}\``); }
        if (left > 0) ctx.wait(left);
        return { err: [`Waiting for [${API}/projects/${hit.i.project}/operations/${hit.o.name}]...done.`], ...g.print([{ name: hit.o.name, operationType: hit.o.operationType, startTime: iso(ctx, hit.o.start), endTime: iso(ctx, hit.o.end), status: 'DONE' }], [['NAME', 'TYPE', 'START', 'END', 'ERROR', 'STATUS'], r => [r.name, r.operationType, r.startTime, r.endTime, '-', r.status]]) };
      }
      return { err: [`ERROR: (gcloud.sql.operations) Invalid choice: '${verb ?? ''}'.`], code: 2 };
    }

    if (resource === 'databases' || resource === 'users') {
      const name = instanceFlag();
      if (verb !== 'list') return err('HTTPError 403: The client is not authorized to make this request.');
      if (!name) return err('argument --instance/-i: Must be specified.', 2);
      const i = find(name);
      if (!i) return notFound(name);
      if (resource === 'databases') return g.print(i.databases.map(d => ({ name: d, charset: 'UTF8', collation: 'en_US.UTF8' })), [['NAME', 'CHARSET', 'COLLATION'], r => [r.name, r.charset, r.collation]]);
      return g.print(i.users.map(u => ({ name: u.name, host: '', type: u.type ?? 'BUILT_IN' })), [['NAME', 'HOST', 'TYPE', 'PASSWORD_POLICY'], r => [r.name, r.host, r.type, '']]);
    }

    if (resource === 'connect') {
      const name = args[1];
      const i = name && find(name);
      if (!i) return name ? notFound(name) : err('argument INSTANCE: Must be specified.', 2);
      return { err: [`ERROR: (gcloud.sql.connect) It seems your client does not have ipv6 connectivity and the database instance does not have an ipv4 address. Please request an ipv4 address for this database instance.`], code: 1 };
    }

    if (resource === 'export') {
      const format = verb;
      const [name, uri] = rest.filter(a => !a.startsWith('-'));
      if (!['sql', 'csv', 'bak'].includes(format)) return { err: [`ERROR: (gcloud.sql.export) Invalid choice: '${format ?? ''}'.`], code: 2 };
      if (!name || !uri) return err('argument INSTANCE URI: Must be specified.', 2);
      const i = find(name);
      if (!i) return notFound(name);
      if (!/^gs:\/\//.test(uri)) return err(`argument URI: Must be a Cloud Storage URI (gs://bucket/object).`, 2);
      if (format === 'csv' && !g.has('query')) return err('argument --query: Must be specified.', 2);
      operation(ctx, i, 'EXPORT', 420);
      ctx.event('sql.export', { instance: i.name, uri, format, query: g.flag('query') });
      if (g.has('async')) return { err: [`Exporting Cloud SQL instance...`] };
      ctx.wait(420);
      return { err: ['Exporting Cloud SQL instance...done.', `Exported [${url(i)}] to [${uri}].`] };
    }

    if (resource === 'flags' && verb === 'list') {
      const version = ctx.state.sql.flagVersion ?? 'POSTGRES_15';
      const rows = KNOWN_FLAGS.map(name => ({ name, type: /^(autovacuum|log_(checkpoints|connections|disconnections|lock_waits)|cloudsql\.(iam_authentication|logical_decoding|enable_pgaudit))$/.test(name) ? 'BOOLEAN' : 'INTEGER', appliesTo: [version], requiresRestart: RESTART_FLAGS.has(name) }));
      return g.print(rows, [['NAME', 'TYPE', 'DATABASE_VERSION', 'ALLOWED_VALUES'], r => [r.name, r.type, version, r.type === 'BOOLEAN' ? 'on,off' : '']]);
    }
    if (resource === 'tiers' && verb === 'list') return g.print([{ tier: 'db-custom-8-32768', RAM: '32 GiB', DiskQuota: '30 TiB' }], [['TIER', 'AVAILABLE_REGIONS', 'RAM', 'DISK'], r => [r.tier, '-', r.RAM, r.DiskQuota]]);
    return { err: [`ERROR: (gcloud.sql) Invalid choice: '${resource ?? ''}'.`, 'Maybe you meant:', '  gcloud sql instances', '  gcloud sql backups', '  gcloud sql operations', '', 'To search the help text of gcloud commands, run:', '  gcloud help -- SEARCH_TERMS'], code: 2 };
  };
}
