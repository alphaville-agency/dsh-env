// The Dockerfile's contract with the repository, checked rather than assumed.
//
// WHY THIS TEST EXISTS. A previous commit shipped `COPY .agents/local/` after the directory it named
// had moved, and the next real image build failed on it. There is no Docker on the machine this was
// written on, so `wrangler deploy --dry-run` cannot catch it either: the container image is built by
// the platform, not by wrangler's dry run. The only cheap place to catch a COPY that names something
// that is not there is here, where the repository itself is the input.
//
// At the FLOOR the image has no COPY at all - the base image plus one toolchain layer - so this file
// pins that too. It is a gate with a purpose: adding a COPY back means updating the list of files
// the image is allowed to expect, which is exactly the review the old broken COPY skipped.
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCKERFILE = join(ROOT, "container.Dockerfile");

const dockerfile = readFileSync(DOCKERFILE, "utf8");
const lines = dockerfile.split("\n");

// The same file with comments removed. Every "this was removed" claim below is checked against the
// INSTRUCTIONS, not the prose: the Dockerfile explains what it removed and why, and a check that
// read the explanation as evidence would fail on its own description.
const code = lines
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

/** Every COPY instruction, with its sources and destination. Continuations are not used for COPYs. */
function copyInstructions() {
  const found = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed.toUpperCase().startsWith("COPY ")) return;
    const tokens = trimmed.split(/\s+/).slice(1);
    assert.ok(tokens.length >= 2, `line ${index + 1}: COPY needs a source and a destination`);
    found.push({ line: index + 1, sources: tokens.slice(0, -1), destination: tokens.at(-1) });
  });
  return found;
}

describe("container.Dockerfile: the base image is the official stable one", () => {
  it("builds on the pinned stable Sandbox image", () => {
    assert.match(
      code,
      /^FROM docker\.io\/cloudflare\/sandbox:0\.12\.9$/m,
      "the image must build on the stable sandbox base the SDK is pinned to",
    );
  });

  it("overrides no entrypoint and no command", () => {
    assert.ok(
      !/^\s*(ENTRYPOINT|CMD)\b/m.test(code),
      "the base image's entrypoint is the container runtime server; overriding it breaks exec",
    );
  });
});

describe("container.Dockerfile: every COPY source exists in the repository", () => {
  for (const { line, sources, destination } of copyInstructions()) {
    for (const source of sources) {
      it(`line ${line}: ${source} -> ${destination}`, () => {
        assert.ok(
          !source.startsWith("--"),
          `line ${line}: flags are not part of a source path, and this Dockerfile uses none`,
        );
        assert.ok(
          existsSync(join(ROOT, source)),
          `line ${line}: COPY source does not exist: ${source}`,
        );
      });
    }
  }

  it("copies exactly the files the harness needs, and says why", () => {
    // This was "copies nothing at all, because that is the floor" while the image had no harness.
    // It is now an allowlist, deliberately: the point of the assertion was never that the count is
    // zero, it was that a new COPY is a conscious act with a source that exists. Keeping an explicit
    // list preserves that, and the reason for each entry stays next to it where a reviewer sees it.
    const expected = [
      // The harness settings, and the profile that declares the TUI bundle. Without these the
      // container boots a launcher with no profile to run.
      "dsh-profile/settings.yaml",
      "dsh-profile/cordis.patch.yml",
      // The automation profile's patch layer. The container is driven over ACP (Agent Client
      // Protocol) as well as the terminal, and that profile must be on our gateway route rather than
      // the deepseek-official row the shipped bundle carries — a control surface pointed at another
      // account cannot see the work. Without this COPY the image boots `dsh --profile acp` against
      // the wrong provider.
      "dsh-profile/acp-cordis.patch.yml",
      // One program on PATH that boots the TUI on that profile, because the terminal route passes a
      // single program name rather than a command with arguments.
      "bin/dsh-session",
      // The launcher's manifest and lockfile. The MANIFEST is copied and the TREE is not: the
      // override that makes the launcher installable has to be declared somewhere reviewable, and
      // the lockfile is what makes the resulting tree identical for every build.
      "dsh-install/package.json",
      "dsh-install/package-lock.json",
      // The agent's own configuration. Without these the environment is a shell with a model and no
      // idea how this project works: no rules, no naming registry, no model routing. They sat in the
      // repository wired to nothing until this was added.
      ".dsh/AGENTS.md",
      ".dsh/MODEL-ROLES.md",
      ".dsh/rules/",
      ".dsh/ontology/",
      // The skills the router names, so its references resolve in the container rather than only on
      // a laptop.
      "dsh-skills/",
      // Fetches the repositories this environment works on. A command rather than session startup,
      // because the disk resets on sleep and a clone at build time would be stale anyway.
      "bin/dsh-prime",
    ];

    const actual = copyInstructions().flatMap(({ sources }) => sources).sort();

    assert.deepEqual(
      actual,
      [...expected].sort(),
      "the image's COPY list changed. If that was intended, add the file here with a reason; if " +
        "not, this is the failure the assertion exists to catch.",
    );
  });

  it("does not COPY the profile's dependency tree, which is installed instead", () => {
    // The profile's node_modules is ~100 MB of transitive dependencies. Committing it would defeat
    // the lockfile, and copying it would put agent state in the image.
    assert.ok(
      !/COPY\s+dsh-profile\/node_modules/.test(code),
      "the profile's installed tree is being copied in; it is installed at build time from the " +
        "committed manifest instead",
    );
  });
});

describe("container.Dockerfile: the things it removes stay removed", () => {
  it("does not install mise", () => {
    assert.ok(!/mise\.run|mise install/.test(code), "mise is back, and it provides nothing");
  });

  it("does not copy a node dependency tree in", () => {
    // The MANIFESTS are copied; the TREES are not. That distinction is the whole point: a lockfile
    // plus `npm ci` reproduces the tree, and committing or copying the tree itself would defeat the
    // lockfile and put megabytes of transitive dependencies in the image.
    //
    // `dsh-install/package.json` used to be listed here as agent state. It is not: the harness is
    // the toolchain, and the image is the toolchain. What stays out is the installed tree, which is
    // asserted separately above.
    for (const path of [".dsh/profiles/", "dsh-install/node_modules/", "dsh-profile/node_modules/"]) {
      assert.ok(!code.includes(`COPY ${path}`), `COPY ${path} is back: that is a dependency tree`);
    }
  });

  it("does not apt-install rclone, which nothing references", () => {
    assert.ok(!/\brclone\b/.test(code), "rclone is back, and nothing uses it");
  });

  it("purges the apt archives in the same RUN that fetches them", () => {
    // The base image keeps downloaded packages, so an apt RUN that does not purge them ships ~299 MB
    // of .deb files. A purge in a LATER layer does not help: layers are additive.
    const aptRuns = lines.filter((line) => line.includes("apt-get install"));
    assert.ok(aptRuns.length > 0, "no apt-get install found: this check would pass vacuously");
    for (const line of aptRuns) {
      const index = lines.indexOf(line);
      // Walk forward through the RUN's continuation lines.
      let body = "";
      for (let i = index; i < lines.length; i += 1) {
        body += `${lines[i]}\n`;
        if (!lines[i].trimEnd().endsWith("\\")) break;
      }
      assert.match(
        body,
        /rm -rf [^\n]*\/var\/cache\/apt\/archives/,
        `the apt RUN at line ${index + 1} does not remove /var/cache/apt/archives in the same RUN`,
      );
    }
  });
});

describe("container.Dockerfile: build assertions are satisfiable", () => {
  it("creates every path it asserts, before asserting it", () => {
    // A build assertion that tests for a file created LATER in the file always fails, and it fails
    // in the way this repository keeps being bitten by: the check reads as correct and the failure
    // looks like something else. This caught a real instance - `test -f /root/.gitconfig` ran before
    // the RUN that writes it.
    const assertionIndex = lines.findIndex((line) => line.startsWith("RUN test -f /root/.dsh/AGENTS.md"));
    assert.ok(assertionIndex > 0, "the build assertion was not found; this check would pass vacuously");

    // Each asserted path, and a fragment of the instruction that creates it.
    const creators = [
      ["/root/.dsh/AGENTS.md", "COPY .dsh/AGENTS.md"],
      ["/root/.dsh/rules", "COPY .dsh/rules/"],
      ["/root/.dsh/ontology/registry.json", "COPY .dsh/ontology/"],
      ["/root/.agents/skills/plane/SKILL.md", "COPY dsh-skills/"],
      ["/root/.gitconfig", "git config --global user.name"],
      ["/usr/local/bin/dsh-prime", "COPY bin/dsh-prime"],
      ["/usr/local/bin/gh", "install -m 0755"],
      ["/usr/local/bin/dsh-session", "COPY bin/dsh-session"],
    ];

    for (const [path, creator] of creators) {
      const creatorIndex = lines.findIndex((line) => line.includes(creator));
      assert.ok(
        creatorIndex >= 0,
        `${path} is asserted but nothing in the Dockerfile creates it (looked for: ${creator})`,
      );
      assert.ok(
        creatorIndex < assertionIndex,
        `${path} is asserted on line ${assertionIndex + 1} but created on line ${creatorIndex + 1}; ` +
          "the assertion runs before its subject exists, so it can never pass",
      );
    }
  });
});
