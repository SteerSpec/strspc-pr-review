#!/usr/bin/env python3
"""Check .github/ISSUE_TEMPLATE against GitHub's issue-forms schema.

Why this exists: GitHub does not report a malformed issue form. It drops it
from /issues/new/choose silently — no error, no banner, no email — so the only
symptom is a template nobody can find. A form can be perfectly valid YAML and
still be dropped, which is exactly how the bug this guard was written for got
merged: `- Composite action (uses: SteerSpec/...)` contains a colon-space, so
YAML read the list item as a mapping rather than the string GitHub requires.

Scope is deliberately narrow: the structural rules GitHub enforces on load.
Prose, field ordering and whether the questions are *good* are review's job.

Schema: https://docs.github.com/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-githubs-form-schema
"""

import pathlib
import sys

try:
    import yaml
except ModuleNotFoundError:
    sys.exit(
        "PyYAML is required to validate the issue forms.\n"
        "  macOS:  python3 -m pip install --user pyyaml\n"
        "  Ubuntu: sudo apt-get install -y python3-yaml\n"
        "GitHub's ubuntu-latest runners ship it preinstalled."
    )

ROOT = pathlib.Path(__file__).resolve().parent.parent / ".github" / "ISSUE_TEMPLATE"

# `markdown` is display-only; the rest collect an answer.
TYPES = {"markdown", "textarea", "input", "dropdown", "checkboxes"}
INPUT_TYPES = TYPES - {"markdown"}

errors = []


def fail(where, message):
    errors.append(f"{where}: {message}")


def check_form(path):
    doc = yaml.safe_load(path.read_text())
    if not isinstance(doc, dict):
        fail(path.name, "top level must be a mapping")
        return

    for key in ("name", "description"):
        if not isinstance(doc.get(key), str) or not doc[key].strip():
            fail(path.name, f"`{key}` is required and must be a non-empty string")

    labels = doc.get("labels")
    if labels is not None and not (
        isinstance(labels, list) and all(isinstance(x, str) for x in labels)
    ):
        fail(path.name, "`labels` must be a list of strings")

    body = doc.get("body")
    if not isinstance(body, list) or not body:
        fail(path.name, "`body` must be a non-empty list")
        return

    seen_ids = set()
    answerable = 0

    for index, element in enumerate(body):
        where = f"{path.name} body[{index}]"
        if not isinstance(element, dict):
            fail(where, "each body element must be a mapping")
            continue

        kind = element.get("type")
        if kind not in TYPES:
            fail(where, f"unknown type {kind!r} (expected one of {sorted(TYPES)})")
            continue

        element_id = element.get("id")
        if element_id is not None:
            if not isinstance(element_id, str) or not element_id.strip():
                fail(where, "`id` must be a non-empty string")
            elif element_id in seen_ids:
                fail(
                    where, f"duplicate id {element_id!r} — ids must be unique per form"
                )
            else:
                seen_ids.add(element_id)

        attributes = element.get("attributes")
        if not isinstance(attributes, dict):
            fail(where, "`attributes` is required")
            continue

        if kind == "markdown":
            if not attributes.get("value"):
                fail(where, "markdown needs `attributes.value`")
            if "validations" in element:
                fail(where, "markdown cannot carry `validations`")
            continue

        answerable += 1
        if not attributes.get("label"):
            fail(where, f"{kind} needs `attributes.label`")

        if kind == "dropdown":
            options = attributes.get("options")
            if not isinstance(options, list) or not options:
                fail(where, "dropdown needs a non-empty `attributes.options`")
            else:
                for position, option in enumerate(options):
                    if not isinstance(option, str):
                        # The colon-space trap: YAML turned the item into a mapping.
                        fail(
                            where,
                            f"option[{position}] is {type(option).__name__}, not a string"
                            f" — quote it: {option!r}",
                        )

        if kind == "checkboxes":
            options = attributes.get("options")
            if not isinstance(options, list) or not options:
                fail(where, "checkboxes needs a non-empty `attributes.options`")
            else:
                for position, option in enumerate(options):
                    if not isinstance(option, dict) or not option.get("label"):
                        fail(where, f"option[{position}] needs a `label`")

        validations = element.get("validations", {})
        if not isinstance(validations, dict):
            fail(where, "`validations` must be a mapping")
        else:
            for key in validations:
                if key != "required":
                    fail(where, f"unknown validation {key!r}")

    if not answerable:
        fail(path.name, "form has no answerable fields — only markdown blocks")

    print(
        f"  {path.name}: {len(body)} elements, {answerable} answerable, ids={sorted(seen_ids)}"
    )


def check_config(path):
    doc = yaml.safe_load(path.read_text())
    if not isinstance(doc, dict):
        fail(path.name, "top level must be a mapping")
        return

    unknown = set(doc) - {"blank_issues_enabled", "contact_links"}
    if unknown:
        fail(path.name, f"unknown keys {sorted(unknown)}")

    if not isinstance(doc.get("blank_issues_enabled"), bool):
        fail(path.name, "`blank_issues_enabled` must be true or false")

    links = doc.get("contact_links") or []
    if not isinstance(links, list):
        fail(path.name, "`contact_links` must be a list")
        links = []

    for index, link in enumerate(links):
        where = f"{path.name} contact_links[{index}]"
        if not isinstance(link, dict):
            fail(where, "each contact link must be a mapping")
            continue
        missing = sorted({"name", "url", "about"} - set(link))
        if missing:
            fail(where, f"missing {missing}")
        url = link.get("url", "")
        # Relative URLs render but go nowhere from the chooser.
        if not isinstance(url, str) or not url.startswith(("http://", "https://")):
            fail(where, f"`url` must be absolute, got {url!r}")

    print(
        f"  {path.name}: blank_issues_enabled={doc.get('blank_issues_enabled')}, "
        f"{len(links)} contact links"
    )


def main():
    if not ROOT.is_dir():
        sys.exit(f"No issue templates found at {ROOT}")

    forms = sorted(ROOT.glob("*.yml")) + sorted(ROOT.glob("*.yaml"))
    if not forms:
        sys.exit(f"No .yml files in {ROOT}")

    print(f"Validating {len(forms)} file(s) in .github/ISSUE_TEMPLATE/")
    for path in forms:
        try:
            (check_config if path.stem == "config" else check_form)(path)
        except yaml.YAMLError as exc:
            fail(path.name, f"is not valid YAML: {exc}")

    if errors:
        print("\nFAIL — GitHub would drop these from the issue chooser:")
        for error in errors:
            print(f"  - {error}")
        return 1

    print("\nAll issue templates conform to GitHub's form schema.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
