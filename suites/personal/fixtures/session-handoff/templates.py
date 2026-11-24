"""Template selection by locale."""


class MissingTemplate(Exception):
    """No template can be used for this kind and locale."""


def resolve(kind, locale, available):
    """The locale whose template to use for this kind, spelled exactly as it appears in `available`.

    kind: the template kind, such as "receipt", "delay", "marketing" or "legal".
    locale: the recipient's locale, such as "fr-CA" or "en".
    available: the locales this kind has templates for, such as ["en", "fr", "de-DE"].
    Raise MissingTemplate when no template may be used.

    The rules are the ones settled in the session (SESSION-*.md).
    """
    raise NotImplementedError("open item 3 in the session handoff")
