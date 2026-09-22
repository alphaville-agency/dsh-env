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

  it("copies nothing beyond the provisioning scripts the Worker invokes", () => {
    // A gate with a purpose. At the floor this list was EMPTY and that was pinned; layer 2 brings
    // back exactly two files, so the list grew by exactly two. Every future COPY has to be added
    // here deliberately, with a source that exists - which is the failure this file was written for.
    const allowed = new Set(["bin/dsh-provision.sh", "bin/dsh-state.sh"]);
    for (const { line, sources } of copyInstructions()) {
      for (const source of sources) {
        assert.ok(allowed.has(source), `line ${line}: COPY ${source} is not in the allowed set`);
      }
    }
  });

  it("makes every copied script executable, because they are 0600 in this repository", () => {
    const scripts = copyInstructions()
      .flatMap(({ sources }) => sources)
      .filter((source) => source.endsWith(".sh"));
    assert.ok(scripts.length > 0, "no scripts are copied: this check would pass vacuously");
    for (const script of scripts) {
      const name = script.split("/").pop();
      assert.match(
        code,
        new RegExp(`chmod 0755[^\\n]*${name.replace(".", "\\.")}`),
        `${name} is copied but not chmod'd, so the image ships a file nobody can execute`,
      );
    }
  });

  it("exposes the copied scripts on PATH under the names the Worker execs", () => {
    // src/names.ts execs `dsh-provision` and `dsh-state` as bare commands, so a COPY into
    // /usr/local/libexec with no symlink would deploy an image whose provisioner is unreachable.
    for (const name of ["dsh-provision", "dsh-state"]) {
      assert.match(
        code,
        new RegExp(`ln -sf /usr/local/libexec/${name}\\.sh /usr/local/bin/${name}`),
        `${name} is copied but not linked onto PATH`,
      );
    }
  });
});

describe("container.Dockerfile: the things it removes stay removed", () => {
  it("does not install mise", () => {
    assert.ok(!/mise\.run|mise install/.test(code), "mise is back, and it provides nothing");
  });

  it("does not copy a node dependency tree in", () => {
    for (const path of ["dsh-install/package.json", ".dsh/profiles/"]) {
      assert.ok(!code.includes(`COPY ${path}`), `COPY ${path} is back: that is agent state`);
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
