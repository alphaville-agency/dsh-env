"""Render a logical ID to provider names, refuse collisions, and audit the claims registry.

The convention is in registry.json: four levels, platform-independent, with provider
serialisations derived from it, plus one authoritative record per claimed name. This module is
deliberately dependency-free so a customer, a Worker and CI can all use the same rules.

The same code is the command line, so a name typed by hand and a name rendered here cannot
disagree:

- ``render <logical_id>`` prints the derived provider names, one ``platform<TAB>name`` per line
- ``check <logical_id>`` prints nothing and only sets the exit code, for use in scripts
- ``--claims`` audits every record: names, vocabularies, provenance, evidence and consumers
- ``--explain <logical_id>`` prints the human-readable view of one record
- ``list`` prints the vocabulary, so no term has to be guessed

What this validator cannot do, and never pretends to: it cannot prove that an email route
delivers, that an actor acted, that a remote resource still exists, or that traffic flows. It
checks the mechanics of the record and the existence of local evidence. Truth of prose is
review, not validation, and ``--explain`` says so on every record.
"""
import datetime
import json
import pathlib
import re
import sys

REGISTRY = pathlib.Path(__file__).with_name("registry.json")
REPO_ROOT = REGISTRY.parent.parent
PLATFORMS = (
    "cloudflare_worker",
    "cloudflare_ai_gateway",
    "cloudflare_container_app",
    "hostname",
    "r2_bucket",
    "hf_dataset",
    "github_repo",
    "image",
    "env_prefix",
)

LEVELS = ("env", "system", "component", "role")
SYSTEM_LEVEL = "system"
HOSTNAME = "hostname"
DECLAREDNESS_KEY = "declaredness"
DECLARED_KEY = "declared"

SCHEMA_KEY = "schema"
STATEMENT_KEY = "statement"
LEVELS_KEY = "levels"
NAMESPACES_KEY = "namespaces"
NAMESPACE_ALLOWS_KEY = "system_allows"
SERIALISATIONS_KEY = "serialisations"
SINGLETONS_KEY = "singletons"
CLAIMS_KEY = "claims"
VOCABULARIES_KEY = "vocabularies"
WORKED_EXAMPLE_KEY = "worked_example"
RENDERS_KEY = "renders"
ENTRIES_KEY = "entries"
LOGICAL_ID_KEY = "logical_id"
PROVIDER_NAMES_KEY = "provider_names"
OWNER_KEY = "owner"
CONTACT_KEY = "contact"
PURPOSE_KEY = "purpose"
LIFECYCLE_KEY = "lifecycle"
LOCATIONS_KEY = "locations"
SOURCE_REF_KEY = "source_ref"
PROVISIONING_KEY = "provisioning"
CONSUMERS_KEY = "consumers"
NO_CONSUMERS_REASON_KEY = "no_consumers_reason"
NO_CONSUMERS_CODE_KEY = "no_consumers_code"
PROVIDER_KEY = "provider"
PROVIDER_REF_KEY = "provider_ref"
NAMESPACE_KEY = "namespace"
ACTION_KEY = "action"
OCCURRED_AT_KEY = "occurred_at"
ACTOR_KEY = "actor"
ACTOR_KIND_KEY = "actor_kind"
MEANS_KEY = "means"
EVIDENCE_KEY = "evidence"
CONSUMER_KEY = "consumer"
RELATIONSHIP_KEY = "relationship"
CODE_KEY = "code"
DETAIL_KEY = "detail"
SINGLETON_RESOURCE_KEY = "resource"
SINGLETON_NAME_KEY = "name"
SINGLETON_REASON_KEY = "reason"
TEMPLATE_KEY = "template"
TEMPLATE_PREFIXED_KEY = "template_prefixed"
PREFIXED_ENVS_KEY = "prefixed_envs"
CASE_KEY = "case"
CASE_UPPER = "upper"
PATTERN_KEY = "pattern"
PLANNED_STALE_DAYS_KEY = "planned_stale_days"

LIFECYCLE_PLANNED = "planned"
LIFECYCLE_ACTIVE = "active"
LIFECYCLE_RETIRED = "retired"
ACTION_CREATED = "created"
ACTION_IMPORTED = "imported"
ACTION_CHANGED = "changed"

LOGICAL_PREFIX = "logical:"
IDENTITY_PREFIX = "identity:"
REGISTRY_PREFIX = "registry:"
REPO_PREFIX = "repo:"
GITHUB_PREFIX = "github:"
URL_SCHEMES = ("http://", "https://")
ZULU_SUFFIXES = ("Z", "z")

RECORD_FIELDS = (
    LOGICAL_ID_KEY,
    PROVIDER_NAMES_KEY,
    OWNER_KEY,
    CONTACT_KEY,
    PURPOSE_KEY,
    LIFECYCLE_KEY,
    LOCATIONS_KEY,
    SOURCE_REF_KEY,
    PROVISIONING_KEY,
    CONSUMERS_KEY,
    NO_CONSUMERS_REASON_KEY,
)
REQUIRED_RECORD_FIELDS = tuple(field for field in RECORD_FIELDS if field != NO_CONSUMERS_REASON_KEY)
LOCATION_FIELDS = (PROVIDER_KEY, NAMESPACE_KEY, PROVIDER_REF_KEY)
PROVISIONING_FIELDS = (
    ACTION_KEY,
    OCCURRED_AT_KEY,
    ACTOR_KEY,
    ACTOR_KIND_KEY,
    MEANS_KEY,
    EVIDENCE_KEY,
)
CONSUMER_FIELDS = (CONSUMER_KEY, RELATIONSHIP_KEY)
REASON_FIELDS = (CODE_KEY, DETAIL_KEY)
PROSE_FIELDS = (PURPOSE_KEY,)
RECORD_VOCABULARY_FIELDS = (OWNER_KEY, CONTACT_KEY, LIFECYCLE_KEY)
LOCATION_VOCABULARY_FIELDS = (PROVIDER_KEY,)
PROVISIONING_VOCABULARY_FIELDS = (ACTION_KEY, ACTOR_KIND_KEY, MEANS_KEY)
CONSUMER_VOCABULARY_FIELDS = (RELATIONSHIP_KEY,)

RENDER_COMMAND = "render"
CHECK_COMMAND = "check"
LIST_COMMAND = "list"
CLAIMS_FLAG = "--claims"
EXPLAIN_FLAG = "--explain"
USAGE = (
    f"usage: validate.py {RENDER_COMMAND} <logical_id>"
    f" | {CHECK_COMMAND} <logical_id>"
    f" | {EXPLAIN_FLAG} <logical_id>"
    f" | {CLAIMS_FLAG}"
    f" | {LIST_COMMAND}"
)

MISMATCH = "recorded as {recorded!r} for platform {platform!r} but renders {rendered!r}"
DUPLICATE = "{name!r} is claimed by two logical ids: {first!r} and {second!r}"
RFC3339 = re.compile(r"^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$")
DEFAULT_PLANNED_STALE_DAYS = 30
EXIT_OK = 0
EXIT_FAIL = 1


class NameError_(ValueError):
    pass


def load(path=REGISTRY):
    return json.loads(pathlib.Path(path).read_text())


def parse(logical_id, registry):
    parts = logical_id.split(".")
    if len(parts) != len(LEVELS):
        raise NameError_(
            f"logical id needs exactly {len(LEVELS)} levels {'.'.join(LEVELS)}; got {logical_id!r}"
        )
    for level, value in zip(LEVELS, parts):
        allowed = registry[LEVELS_KEY][level]
        if value not in allowed:
            raise NameError_(f"level {level!r} rejects {value!r}; allowed: {', '.join(allowed)}")
    return tuple(parts)


def render(logical_id, registry=None):
    registry = registry or load()
    env, system, component, role = parse(logical_id, registry)
    out = {}
    for platform in PLATFORMS:
        spec = registry[SERIALISATIONS_KEY][platform]
        template = spec[TEMPLATE_KEY]
        # Which env is prefixed is DATA, not a comparison against `prod`. The bare hostname label
        # belongs to whichever env is not subordinate to another env of the same system: `prod`
        # because it is the top of a tiered system, and `shared` because it is not tiered at all.
        # Hard-coding `prod` here is what made `shared` unrepresentable, and what stated a rule in
        # terms of one of its own cases.
        if platform == HOSTNAME and env in spec[PREFIXED_ENVS_KEY]:
            template = spec[TEMPLATE_PREFIXED_KEY]
        name = (template.replace("{env}", env).replace("{system}", system)
                        .replace("{component}", component).replace("{role}", role))
        if spec.get(CASE_KEY) == CASE_UPPER:
            name = name.upper()
        pattern = spec.get(PATTERN_KEY)
        if pattern and not re.match(pattern, name):
            raise NameError_(f"level {platform!r} pattern {pattern} rejects {name!r}")
        namespace = registry[NAMESPACES_KEY].get(spec.get(NAMESPACE_KEY, ""))
        out[platform] = f"{namespace}/{name}" if namespace else name
    return out


def collisions(names_by_id):
    """Provider names wanted by more than one logical ID, in the order they were first seen.

    ``names_by_id`` is an iterable of ``(logical_id, names)`` pairs. This is the one collision
    implementation: a bare list of logical IDs and the recorded claims table both come through
    here, so a hand-written table and a rendered one cannot disagree about what a collision is.
    """
    owners = {}
    for logical_id, names in names_by_id:
        for name in names:
            holders = owners.setdefault(name, [])
            if logical_id not in holders:
                holders.append(logical_id)
    return {name: holders for name, holders in owners.items() if len(holders) > 1}


def claim(logical_ids, registry=None):
    """Reserve every provider name. Two IDs wanting one name is refused, not resolved."""
    registry = registry or load()
    rendered = [
        (logical_id, tuple(render(logical_id, registry).values())) for logical_id in logical_ids
    ]
    for name, holders in collisions(rendered).items():
        raise NameError_(DUPLICATE.format(name=name, first=holders[0], second=holders[1]))
    return {name: logical_id for logical_id, names in rendered for name in names}


def find_record(registry, logical_id):
    entries, _ = entries_of(registry, CLAIMS_KEY)
    for entry in entries:
        if isinstance(entry, dict) and entry.get(LOGICAL_ID_KEY) == logical_id:
            return entry
    return None


def entries_of(registry, section):
    """The ``entries`` list of a registry section, plus the problem that stops it being checked."""
    found = registry.get(section)
    if not isinstance(found, dict) or not isinstance(found.get(ENTRIES_KEY), list):
        return [], f"registry section {section!r} has no {ENTRIES_KEY!r} list"
    return found[ENTRIES_KEY], None


def vocabulary(registry, name):
    return registry.get(VOCABULARIES_KEY, {}).get(name, [])


def identity_vocabulary(registry):
    """An identity consumer is an owner or a contact, so no identity is defined a second time."""
    return sorted(set(vocabulary(registry, OWNER_KEY)) | set(vocabulary(registry, CONTACT_KEY)))


def parse_timestamp(value):
    if not isinstance(value, str) or not RFC3339.match(value):
        return None
    text = value[:-1] + "+00:00" if value[-1] in ZULU_SUFFIXES else value
    try:
        return datetime.datetime.fromisoformat(text)
    except ValueError:
        return None


def shape_problems(entry, fields, required, where):
    if not isinstance(entry, dict):
        return [f"{where}: expected an object"]
    problems = []
    for key in sorted(set(entry) - set(fields)):
        problems.append(f"{where}: unknown field {key!r}")
    for key in required:
        if key not in entry:
            problems.append(f"{where}: missing field {key!r}")
    return problems


def text_problems(where, field, value):
    if not isinstance(value, str) or not value.strip():
        return [f"{where}: {field} must be a non-blank string"]
    return []


def vocabulary_problems(registry, record, where, fields):
    problems = []
    for field in fields:
        if field not in record:
            continue
        allowed = vocabulary(registry, field)
        value = record[field]
        if value not in allowed:
            problems.append(
                f"{where}: {field} {value!r} is not approved; allowed: {', '.join(allowed)}"
            )
    return problems


def name_problems(registry, record, logical_id, where):
    rendered = render(logical_id, registry)
    provider_names = record.get(PROVIDER_NAMES_KEY)
    if not isinstance(provider_names, dict) or not provider_names:
        return [
            f"{where} ({logical_id}): {PROVIDER_NAMES_KEY} must be a non-empty object of"
            " platform to name"
        ]
    problems = []
    for platform, recorded_name in provider_names.items():
        if platform not in registry[SERIALISATIONS_KEY]:
            problems.append(
                f"{where} ({logical_id}): {platform!r} is not a serialisation in the registry"
            )
            continue
        if not isinstance(recorded_name, str) or not recorded_name.strip():
            problems.append(f"{where} ({logical_id}): {platform} must map to a non-blank name")
            continue
        if recorded_name != rendered[platform]:
            problems.append(
                f"{where} ({logical_id}): "
                + MISMATCH.format(
                    recorded=recorded_name, platform=platform, rendered=rendered[platform]
                )
            )
    return problems


def location_problems(registry, record, where, system):
    if LOCATIONS_KEY not in record:
        return []
    locations = record[LOCATIONS_KEY]
    if not isinstance(locations, list) or not locations:
        return [f"{where}: {LOCATIONS_KEY} must be a non-empty list of locations"]
    problems = []
    allows = registry[NAMESPACES_KEY].get(NAMESPACE_ALLOWS_KEY, {})
    for position, location in enumerate(locations):
        here = f"{where}.{LOCATIONS_KEY}[{position}]"
        problems.extend(shape_problems(location, LOCATION_FIELDS, LOCATION_FIELDS, here))
        if not isinstance(location, dict):
            continue
        problems.extend(vocabulary_problems(registry, location, here, LOCATION_VOCABULARY_FIELDS))
        if NAMESPACE_KEY in location:
            problems.extend(text_problems(here, NAMESPACE_KEY, location[NAMESPACE_KEY]))
        if PROVIDER_REF_KEY in location:
            problems.extend(text_problems(here, PROVIDER_REF_KEY, location[PROVIDER_REF_KEY]))
        namespace = location.get(NAMESPACE_KEY)
        allowed_systems = allows.get(namespace)
        if namespace is None:
            continue
        if allowed_systems is None:
            problems.append(
                f"{here}: namespace {namespace!r} is not recorded in"
                f" {NAMESPACES_KEY}.{NAMESPACE_ALLOWS_KEY}"
            )
        elif system is not None and system not in allowed_systems:
            problems.append(
                f"{here}: namespace {namespace!r} does not serve {SYSTEM_LEVEL} {system!r};"
                f" it allows: {', '.join(allowed_systems)}"
            )
    return problems


def source_problems(record, where, logical_id):
    if SOURCE_REF_KEY not in record:
        return []
    source = record[SOURCE_REF_KEY]
    if not isinstance(source, str) or not source.strip():
        return [f"{where}: {SOURCE_REF_KEY} must be a non-blank string"]
    if source.startswith(REGISTRY_PREFIX):
        target = source[len(REGISTRY_PREFIX):]
        if logical_id is not None and target != logical_id:
            return [
                f"{where}: {SOURCE_REF_KEY} {source!r} points at {target!r},"
                f" not at {logical_id!r}"
            ]
        return []
    if source.startswith(REPO_PREFIX):
        path = source[len(REPO_PREFIX):]
        if not (REPO_ROOT / path).is_file():
            return [f"{where}: {SOURCE_REF_KEY} {source!r} is not a file in this repository"]
        return []
    if source.startswith(GITHUB_PREFIX) or source.startswith(URL_SCHEMES):
        return []
    return [
        f"{where}: {SOURCE_REF_KEY} {source!r} must start with"
        f" {REGISTRY_PREFIX}, {REPO_PREFIX}, {GITHUB_PREFIX} or {URL_SCHEMES[0]}"
    ]


def evidence_problems(where, value):
    if not isinstance(value, list) or not value:
        return [
            f"{where}: {EVIDENCE_KEY} must be a non-empty list of repository-relative paths"
            " or URLs"
        ]
    problems = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            problems.append(f"{where}: every {EVIDENCE_KEY} entry must be a non-blank string")
            continue
        if item.startswith(URL_SCHEMES):
            continue
        if pathlib.PurePosixPath(item).is_absolute():
            problems.append(f"{where}: evidence {item!r} must be repository-relative")
            continue
        if not (REPO_ROOT / item).is_file():
            problems.append(f"{where}: evidence {item!r} does not exist in this repository")
    return problems


def provisioning_problems(registry, record, where):
    if PROVISIONING_KEY not in record:
        return []
    events = record[PROVISIONING_KEY]
    if not isinstance(events, list) or not events:
        return [f"{where}: {PROVISIONING_KEY} must be a non-empty list of provisioning events"]
    problems = []
    positions = {}
    confirmed = False
    for position, event in enumerate(events):
        here = f"{where}.{PROVISIONING_KEY}[{position}]"
        problems.extend(shape_problems(event, PROVISIONING_FIELDS, PROVISIONING_FIELDS, here))
        if not isinstance(event, dict):
            continue
        problems.extend(
            vocabulary_problems(registry, event, here, PROVISIONING_VOCABULARY_FIELDS)
        )
        action = event.get(ACTION_KEY)
        if action in (ACTION_CREATED, ACTION_IMPORTED):
            confirmed = True
        if OCCURRED_AT_KEY in event:
            if parse_timestamp(event[OCCURRED_AT_KEY]) is None:
                problems.append(
                    f"{here}: {OCCURRED_AT_KEY} {event[OCCURRED_AT_KEY]!r} is not an RFC 3339"
                    " timestamp"
                )
        if ACTOR_KEY in event:
            problems.extend(text_problems(here, ACTOR_KEY, event[ACTOR_KEY]))
        if EVIDENCE_KEY in event:
            problems.extend(evidence_problems(here, event[EVIDENCE_KEY]))
        fingerprint = (
            action,
            event.get(OCCURRED_AT_KEY),
            event.get(ACTOR_KEY),
            event.get(MEANS_KEY),
        )
        if fingerprint in positions:
            problems.append(
                f"{here}: duplicate provisioning event, already recorded at position"
                f" {positions[fingerprint]}"
            )
        else:
            positions[fingerprint] = position
    if not confirmed:
        problems.append(
            f"{where}: no {ACTION_CREATED!r} or {ACTION_IMPORTED!r} provisioning event"
        )
    return problems


def consumption_problems(registry, record, where):
    """The consumers/no_consumers_reason pair: exactly one of them, and the code must match."""
    if CONSUMERS_KEY not in record:
        return []
    consumers = record[CONSUMERS_KEY]
    reason = record.get(NO_CONSUMERS_REASON_KEY)
    problems = []
    if consumers is None:
        lifecycle = record.get(LIFECYCLE_KEY)
        if lifecycle == LIFECYCLE_ACTIVE:
            problems.append(
                f"{where}: lifecycle {LIFECYCLE_ACTIVE!r} requires at least one consumer;"
                " there is no foundational, internal or future-use exemption"
            )
        if not isinstance(reason, dict):
            problems.append(
                f"{where}: {CONSUMERS_KEY} is null, so {NO_CONSUMERS_REASON_KEY} is required"
            )
            return problems
        reason_where = where + f".{NO_CONSUMERS_REASON_KEY}"
        problems.extend(shape_problems(reason, REASON_FIELDS, REASON_FIELDS, reason_where))
        problems.extend(text_problems(reason_where, DETAIL_KEY, reason.get(DETAIL_KEY)))
        code = reason.get(CODE_KEY)
        allowed = vocabulary(registry, NO_CONSUMERS_CODE_KEY)
        if code not in allowed:
            problems.append(
                f"{where}: {NO_CONSUMERS_REASON_KEY}.{CODE_KEY} {code!r} is not approved;"
                f" allowed: {', '.join(allowed)}"
            )
        elif code != lifecycle:
            problems.append(
                f"{where}: {NO_CONSUMERS_REASON_KEY}.{CODE_KEY} {code!r} does not match"
                f" {LIFECYCLE_KEY} {lifecycle!r}"
            )
        return problems
    if not isinstance(consumers, list) or not consumers:
        problems.append(
            f"{where}: {CONSUMERS_KEY} must be a non-empty list, or null with"
            f" {NO_CONSUMERS_REASON_KEY}"
        )
        return problems
    if reason is not None:
        problems.append(
            f"{where}: {CONSUMERS_KEY} and {NO_CONSUMERS_REASON_KEY} cannot both be populated"
        )
    return problems


def consumer_target_problems(registry, record, where, logical_id, known_ids):
    """Every recorded consumer must be a syntax the registry defines, and must resolve."""
    consumers = record.get(CONSUMERS_KEY)
    if not isinstance(consumers, list) or not consumers:
        return []
    problems = []
    self_references = 0
    for position, consumer in enumerate(consumers):
        here = f"{where}.{CONSUMERS_KEY}[{position}]"
        problems.extend(shape_problems(consumer, CONSUMER_FIELDS, CONSUMER_FIELDS, here))
        if not isinstance(consumer, dict):
            continue
        problems.extend(vocabulary_problems(registry, consumer, here, CONSUMER_VOCABULARY_FIELDS))
        reference = consumer.get(CONSUMER_KEY)
        if CONSUMER_KEY in consumer:
            problems.extend(text_problems(here, CONSUMER_KEY, reference))
        if not isinstance(reference, str):
            continue
        if reference.startswith(LOGICAL_PREFIX):
            target = reference[len(LOGICAL_PREFIX):]
            if target == logical_id:
                self_references += 1
            elif target not in known_ids:
                problems.append(
                    f"{here}: {reference!r} does not resolve to a record in"
                    f" {CLAIMS_KEY}.{ENTRIES_KEY}"
                )
        elif reference.startswith(IDENTITY_PREFIX):
            identity = reference[len(IDENTITY_PREFIX):]
            allowed = identity_vocabulary(registry)
            if identity not in allowed:
                problems.append(
                    f"{here}: identity {identity!r} is not approved; allowed:"
                    f" {', '.join(allowed)}"
                )
        else:
            problems.append(
                f"{here}: {reference!r} must be {LOGICAL_PREFIX}<logical_id> or"
                f" {IDENTITY_PREFIX}<identity>"
            )
    if self_references == len(consumers):
        problems.append(
            f"{where}: {logical_id!r} is its own only consumer, which is not a consumer"
        )
    return problems


def record_problems(registry, entry, index):
    where = f"{CLAIMS_KEY}.{ENTRIES_KEY}[{index}]"
    problems = shape_problems(entry, RECORD_FIELDS, REQUIRED_RECORD_FIELDS, where)
    if not isinstance(entry, dict):
        return problems
    logical_id = entry.get(LOGICAL_ID_KEY)
    system = None
    if LOGICAL_ID_KEY in entry:
        if not isinstance(logical_id, str) or not logical_id.strip():
            problems.append(f"{where}: {LOGICAL_ID_KEY} must be a non-blank string")
        else:
            try:
                parts = parse(logical_id, registry)
            except NameError_ as exc:
                problems.append(f"{where} ({logical_id}): {exc}")
            else:
                system = parts[LEVELS.index(SYSTEM_LEVEL)]
                problems.extend(name_problems(registry, entry, logical_id, where))
    problems.extend(vocabulary_problems(registry, entry, where, RECORD_VOCABULARY_FIELDS))
    if PURPOSE_KEY in entry:
        problems.extend(text_problems(where, PURPOSE_KEY, entry[PURPOSE_KEY]))
    problems.extend(location_problems(registry, entry, where, system))
    problems.extend(source_problems(entry, where, logical_id if isinstance(logical_id, str)
                                    else None))
    problems.extend(provisioning_problems(registry, entry, where))
    problems.extend(consumption_problems(registry, entry, where))
    return problems


def singleton_problems(registry):
    """Every singleton entry must carry the resource, the name and the reason it is fixed by hand."""
    entries, problem = entries_of(registry, SINGLETONS_KEY)
    if problem:
        return [problem]
    problems = []
    fields = (SINGLETON_RESOURCE_KEY, SINGLETON_NAME_KEY, SINGLETON_REASON_KEY)
    for index, entry in enumerate(entries):
        for field in fields:
            value = entry.get(field) if isinstance(entry, dict) else None
            if not isinstance(value, str) or not value.strip():
                problems.append(
                    f"{SINGLETONS_KEY}.{ENTRIES_KEY}[{index}]: {field!r} is missing or empty"
                )
    return problems


def claims_problems(registry):
    """Every defect in the claims table, not just the first: an empty list means it is sound."""
    entries, problem = entries_of(registry, CLAIMS_KEY)
    if problem:
        return [problem]
    problems = []
    records = []
    positions = {}
    for index, entry in enumerate(entries):
        problems.extend(record_problems(registry, entry, index))
        if not isinstance(entry, dict):
            continue
        logical_id = entry.get(LOGICAL_ID_KEY)
        if not isinstance(logical_id, str) or not logical_id.strip():
            continue
        recorded = entry.get(PROVIDER_NAMES_KEY)
        records.append((logical_id, tuple(recorded.values()) if isinstance(recorded, dict) else ()))
        if logical_id in positions:
            problems.append(
                f"{CLAIMS_KEY}.{ENTRIES_KEY}[{index}]: duplicate {LOGICAL_ID_KEY}"
                f" {logical_id!r}, already recorded at position {positions[logical_id]}"
            )
        else:
            positions[logical_id] = index
    known_ids = set(positions)
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        logical_id = entry.get(LOGICAL_ID_KEY)
        if not isinstance(logical_id, str) or not logical_id.strip():
            continue
        where = f"{CLAIMS_KEY}.{ENTRIES_KEY}[{index}]"
        problems.extend(
            consumer_target_problems(registry, entry, where, logical_id, known_ids)
        )
    for name, holders in collisions(records).items():
        message = DUPLICATE.format(name=name, first=holders[0], second=holders[1])
        problems.append(f"{CLAIMS_KEY}: {message}")
    problems.extend(singleton_problems(registry))
    return problems


def naming_shape_problems(registry):
    """The registry's own shape: the places where its prose and its data have to agree.

    Two of those claims would otherwise rot silently, so they are checked rather than trusted:

    - ``prefixed_envs`` is the machine-readable half of the hostname note. Each term must be a real
      env, and at least one env must still own the bare label, or a logical ID renders onto a
      hostname the note says is owned by somebody.
    - every serialisation must be classified in ``declaredness.declared``. A provider name nobody has
      decided is ours - or is not - is exactly the drift that section exists to stop, and adding a
      serialisation without classifying it is the mistake the check catches.
    """
    problems = []
    envs = registry[LEVELS_KEY]["env"]
    prefixed = registry[SERIALISATIONS_KEY][HOSTNAME].get(PREFIXED_ENVS_KEY)
    where = f"{SERIALISATIONS_KEY}.{HOSTNAME}"
    if not isinstance(prefixed, list) or not prefixed:
        problems.append(f"{where}: {PREFIXED_ENVS_KEY} must be a non-empty list of env terms")
    else:
        for env in prefixed:
            if env not in envs:
                problems.append(
                    f"{where}: {PREFIXED_ENVS_KEY} names {env!r}, which is not an env term;"
                    f" allowed: {', '.join(envs)}"
                )
        if set(prefixed) >= set(envs):
            problems.append(
                f"{where}: every env is prefixed, so no env owns the bare hostname label and"
                " the note cannot be true"
            )
    declared = registry.get(DECLAREDNESS_KEY, {}).get(DECLARED_KEY)
    if not isinstance(declared, list) or not declared:
        problems.append(
            f"{DECLAREDNESS_KEY}.{DECLARED_KEY} must be a non-empty list of serialisations"
        )
    else:
        unclassified = sorted(set(registry[SERIALISATIONS_KEY]) - set(declared))
        unknown = sorted(set(declared) - set(registry[SERIALISATIONS_KEY]))
        if unclassified:
            problems.append(
                f"{DECLAREDNESS_KEY}.{DECLARED_KEY}: no declared/derived decision for"
                f" {', '.join(unclassified)}"
            )
        if unknown:
            problems.append(
                f"{DECLAREDNESS_KEY}.{DECLARED_KEY}: names {', '.join(unknown)}, which"
                " is not a serialisation in the registry"
            )
    return problems


def latest_act(record):
    events = record.get(PROVISIONING_KEY)
    if not isinstance(events, list):
        return None
    latest = None
    for event in events:
        if not isinstance(event, dict):
            continue
        moment = parse_timestamp(event.get(OCCURRED_AT_KEY))
        if latest is None or (moment is not None and moment > latest[0]):
            latest = (moment, event)
    return latest


def worked_example_warnings(registry):
    example = registry.get(WORKED_EXAMPLE_KEY)
    if not isinstance(example, dict):
        return []
    logical_id = example.get(LOGICAL_ID_KEY)
    shown = example.get(RENDERS_KEY)
    if not isinstance(logical_id, str) or not isinstance(shown, dict):
        return []
    try:
        derived = render(logical_id, registry)
    except NameError_ as exc:
        return [f"{WORKED_EXAMPLE_KEY}: {exc}"]
    warnings = []
    for platform, recorded in shown.items():
        if platform in derived and recorded != derived[platform]:
            warnings.append(
                f"{WORKED_EXAMPLE_KEY} ({logical_id}): {platform} shows {recorded!r} but"
                f" now renders {derived[platform]!r}"
            )
    return warnings


def claims_warnings(registry, now=None):
    """Things a human has to judge: remote evidence, stale plans, and prose that is not proof."""
    entries, problem = entries_of(registry, CLAIMS_KEY)
    if problem:
        return []
    now = now or datetime.datetime.now(datetime.timezone.utc)
    stale_days = (registry.get(CLAIMS_KEY) or {}).get(
        PLANNED_STALE_DAYS_KEY, DEFAULT_PLANNED_STALE_DAYS
    )
    warnings = []
    for index, entry in enumerate(entries):
        if not isinstance(entry, dict):
            continue
        where = f"{CLAIMS_KEY}.{ENTRIES_KEY}[{index}]"
        for position, event in enumerate(entry.get(PROVISIONING_KEY) or []):
            if not isinstance(event, dict):
                continue
            for item in event.get(EVIDENCE_KEY) or []:
                if isinstance(item, str) and item.startswith(URL_SCHEMES):
                    warnings.append(
                        f"{where}.{PROVISIONING_KEY}[{position}]: evidence {item!r} is remote"
                        " and was not checked offline"
                    )
        prose = [field for field in PROSE_FIELDS if isinstance(entry.get(field), str)]
        reason = entry.get(NO_CONSUMERS_REASON_KEY)
        if isinstance(reason, dict) and isinstance(reason.get(DETAIL_KEY), str):
            prose.append(f"{NO_CONSUMERS_REASON_KEY}.{DETAIL_KEY}")
        if prose:
            warnings.append(
                f"{where}: {', '.join(prose)} is prose: required for a cold reader, but a review"
                " obligation rather than something this validator can verify"
            )
        source = entry.get(SOURCE_REF_KEY)
        if isinstance(source, str) and source.startswith((GITHUB_PREFIX,) + URL_SCHEMES):
            warnings.append(
                f"{where}: {SOURCE_REF_KEY} {source!r} is remote and was not checked offline"
            )
        if entry.get(LIFECYCLE_KEY) == LIFECYCLE_PLANNED:
            act = latest_act(entry)
            moment = act[0] if act else None
            if moment is not None and (now - moment).days > stale_days:
                warnings.append(
                    f"{where}: {LIFECYCLE_PLANNED!r} since {moment.isoformat()}, more than"
                    f" {stale_days} days ago: name or retire it"
                )
    warnings.extend(worked_example_warnings(registry))
    return warnings


def print_vocabulary(registry=None):
    registry = registry or load()
    for level in LEVELS:
        print(f"{level}: {', '.join(registry[LEVELS_KEY][level])}")


def explain_lines(registry, logical_id, record, rendered):
    system = parse(logical_id, registry)[LEVELS.index(SYSTEM_LEVEL)]
    lines = [
        f"logical id: {logical_id}",
        f"scope (derived from {SYSTEM_LEVEL}): {system}",
        f"purpose: {record.get(PURPOSE_KEY, '')}",
        f"owner: {record.get(OWNER_KEY, '')}  contact: {record.get(CONTACT_KEY, '')}",
        f"lifecycle: {record.get(LIFECYCLE_KEY, '')}",
        "names:",
    ]
    for platform in sorted(rendered):
        lines.append(f"    {platform}\t{rendered[platform]}")
    lines.append("locations:")
    for location in record.get(LOCATIONS_KEY) or []:
        if not isinstance(location, dict):
            continue
        lines.append(
            "    "
            f"{location.get(PROVIDER_KEY, '')} {location.get(NAMESPACE_KEY, '')}"
            f" {location.get(PROVIDER_REF_KEY, '')}"
        )
    lines.append(f"source: {record.get(SOURCE_REF_KEY, '')}")
    act = latest_act(record)
    if act is None:
        lines.append("provisioned: no provisioning event is recorded")
    else:
        event = act[1]
        lines.append(
            f"provisioned: {event.get(ACTION_KEY, '')} {event.get(OCCURRED_AT_KEY, '')}"
            f" by {event.get(ACTOR_KEY, '')} ({event.get(ACTOR_KIND_KEY, '')})"
            f" via {event.get(MEANS_KEY, '')}"
        )
        for item in event.get(EVIDENCE_KEY) or []:
            lines.append(f"    evidence: {item}")
    consumers = record.get(CONSUMERS_KEY)
    if isinstance(consumers, list) and consumers:
        lines.append("consumers:")
        for consumer in consumers:
            if not isinstance(consumer, dict):
                continue
            lines.append(
                f"    {consumer.get(CONSUMER_KEY, '')}"
                f" ({consumer.get(RELATIONSHIP_KEY, '')})"
            )
    else:
        reason = record.get(NO_CONSUMERS_REASON_KEY)
        detail = reason.get(DETAIL_KEY, "") if isinstance(reason, dict) else ""
        code = reason.get(CODE_KEY, "") if isinstance(reason, dict) else ""
        lines.append(f"consumers: none ({code}): {detail}")
    lines.append(
        "not verified here: prose is review, and this validator cannot prove that an identity"
        " receives mail, that an actor acted, that a remote resource exists, or that traffic flows"
    )
    return lines


def explain(logical_id, registry=None):
    registry = registry or load()
    try:
        rendered = render(logical_id, registry)
    except NameError_ as exc:
        print(exc, file=sys.stderr)
        return EXIT_FAIL
    record = find_record(registry, logical_id)
    if record is None:
        print(
            f"no record for {logical_id!r} in {CLAIMS_KEY}.{ENTRIES_KEY}: the name has no owner,"
            " purpose or consumer; add one before using the name",
            file=sys.stderr,
        )
        return EXIT_FAIL
    for line in explain_lines(registry, logical_id, record, rendered):
        print(line)
    return EXIT_OK


def run_one(command, logical_id):
    """``render`` prints the derived names; ``check`` prints nothing and only sets the exit code."""
    try:
        rendered = render(logical_id)
    except NameError_ as exc:
        print(exc, file=sys.stderr)
        return EXIT_FAIL
    if command == RENDER_COMMAND:
        for platform in sorted(rendered):
            print(f"{platform}\t{rendered[platform]}")
    return EXIT_OK


def report_claims(registry=None):
    registry = registry or load()
    problems = claims_problems(registry) + naming_shape_problems(registry)
    for warning in claims_warnings(registry):
        print(f"warning: {warning}", file=sys.stderr)
    if problems:
        for problem in problems:
            print(f"error: {problem}", file=sys.stderr)
        print(f"{len(problems)} claim defect(s)", file=sys.stderr)
        return EXIT_FAIL
    entries, _ = entries_of(registry, CLAIMS_KEY)
    names = sum(
        len(entry.get(PROVIDER_NAMES_KEY, {}))
        for entry in entries
        if isinstance(entry, dict)
    )
    print(f"claims ok: {len(entries)} logical ids, {names} provider names")
    return EXIT_OK


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv == [CLAIMS_FLAG]:
        return report_claims()
    if argv == [LIST_COMMAND]:
        print_vocabulary()
        return EXIT_OK
    if len(argv) == 2 and argv[0] in (RENDER_COMMAND, CHECK_COMMAND):
        return run_one(argv[0], argv[1])
    if len(argv) == 2 and argv[0] == EXPLAIN_FLAG:
        return explain(argv[1])
    print(USAGE, file=sys.stderr)
    return EXIT_FAIL


if __name__ == "__main__":
    sys.exit(main())
