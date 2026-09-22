// The ontology pin check.
//
// WHY THIS TEST EXISTS. The pinned ontology copy under `.dsh/ontology/` records, in `PIN.json`, the
// sha256 of the registry and validator it was derived from. That record is worthless unless
// something recomputes it: in commit 5b67203 the registry was renamed (`dev.*` -> `shared.*`) while
// the pin still held the old hash, and NOTHING failed. The one script that checked the pin,
// `tools/check-drift.sh`, was deleted in that same commit - so the tree went green while its pin was
// wrong. This test is the replacement, and it is the smaller, more durable half: a pin check is 30
// lines, so it does not need to live in a 400-line installer that nothing calls.
//
// The lesson it encodes: deleting a check and breaking its subject in one change is easy to do and
// invisible in review. A pin is a claim about provenance; an unchecked claim is a dangling
// reference wearing a hash.
//
// This does NOT verify that the copy is current with upstream - it cannot, there is no network
// guarantee here and the copy is a deliberate fork (see the `known_stale` block in PIN.json). It
// verifies only that the pin describes the files beside it. That is exactly the property that broke.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ONTOLOGY_DIR = join(REPO_ROOT, ".dsh", "ontology");
const PIN_PATH = join(ONTOLOGY_DIR, "PIN.json");

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

test("every file named in the ontology pin exists and matches its recorded hash", () => {
    const pin = JSON.parse(readFileSync(PIN_PATH, "utf8"));
    const files = pin.files ?? {};

    assert.ok(Object.keys(files).length > 0, "PIN.json records no files, so it pins nothing");

    for (const [name, recorded] of Object.entries(files)) {
        const actual = sha256(join(ONTOLOGY_DIR, name));
        assert.equal(
            actual,
            recorded,
            `${name} does not match its pin: recorded ${recorded}, actual ${actual}. ` +
                "Refresh .dsh/ontology/PIN.json in the same change that edits the file it pins.",
        );
    }
});

test("the pin says where the copy came from and states it is derived", () => {
    const pin = JSON.parse(readFileSync(PIN_PATH, "utf8"));

    // A pin without a source is a hash with no meaning, and a copy that does not declare itself
    // derived invites someone to edit it in place as if it were canonical.
    assert.ok(pin.source_repo, "PIN.json must name the source repository");
    assert.match(
        `${pin.known_stale ? JSON.stringify(pin.known_stale) : ""} ${pin.rule ?? ""}`,
        /stale|canonical|derived/i,
        "PIN.json must state that this copy is derived and not the canonical one",
    );
});