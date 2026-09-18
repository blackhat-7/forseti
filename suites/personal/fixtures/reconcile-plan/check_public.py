from reconcile import plan
s={"owner":"acct-a","rows":[{"folder":"keep","owner":"acct-a"}],"objects":[{"folder":"new","owner":"acct-a"},{"folder":"new","owner":"acct-a"},{"folder":"../escape","owner":"acct-a"}]}
assert plan(s)=={"add":["new"],"reject":["../escape"],"delete":[]}
print("public check passed")
