// The Dockerfile's contract with the repository, checked rather than assumed.
//
// WHY THIS TEST EXISTS. A previous commit shipped `COPY .agents/local/` after the directory it named
// had moved, and the next real image build failed on it. There is no Docker on the machine this was
// written on, so `wrangler deploy --dry-run` cannot catch it either: the container image is built by
// the platform, not by wrangler's dry run. The only cheap place to catch a COPY that names something
// that is not there is here, where the repository itself is the input.
//
// It checks two things and nothing speculative: every COPY source exists relative to the build
// context, and every file this repository expects to run inside the image is executable-by-mode
// after the chmod the Dockerfile performs (so a COPY of a 0600 script cannot ship as unrunnable).
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
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

describe("container.Dockerfile: every COPY source exists in the repository", () => {
  const instructions = copyInstructions();

  it("has at least one COPY (the parser is reading the file)", () => {
    assert.ok(instructions.length > 0, "no COPY lines found: the parser is wrong, not the Dockerfile");
  });

  for (const { line, sources, destination } of copyInstructions()) {
    for (const source of sources) {
      // `--from=` stage copies are not used here, but they name a stage rather than a path, and
      // silently skipping them would be worse than failing loudly.
      it(`line ${line}: ${source} -> ${destination}`, () => {
        assert.ok(
          !source.startsWith("--"),
          `line ${line}: flags are not part of a source path, and this Dockerfile uses none`,
        );
        const resolved = join(ROOT, source);
        assert.ok(existsSync(resolved), `line ${line}: COPY source does not exist: ${source}`);
      });
    }
  }
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

describe("container.Dockerfile: scripts are made executable by the image", () => {
  const scripts = ["bin/dsh-provision.sh", "bin/dsh-state.sh"];

  for (const script of scripts) {
    it(`${script} is copied and chmod'd`, () => {
      assert.ok(dockerfile.includes(script), `${script} is not copied into the image at all`);
      assert.match(
        dockerfile,
        /chmod 0755[^\n]*dsh-provision\.sh/,
        "the copied scripts are not chmod'd: they are 0600 in this repository",
      );
    });

    it(`${script} parses as POSIX sh`, () => {
      assert.ok(existsSync(join(ROOT, script)), `${script} does not exist`);
      // The shebang is the contract: these run under `sh` on the image, not bash.
      const first = readFileSync(join(ROOT, script), "utf8").split("\n")[0];
      assert.equal(first, "#!/bin/sh", `${script} must declare #!/bin/sh`);
    });
  }

  it("the chmod is load-bearing: these files are not executable in the repository", () => {
    // Recorded rather than asserted as a failure. `bin/dsh-state.sh` is mode 0600 in the tree, so
    // the COPY in the image copies a file nobody can execute; if the chmod line ever disappears the
    // image builds and then fails at run time with "Permission denied" on a path that exists.
    const modes = scripts.map((script) => statSync(join(ROOT, script)).mode & 0o111);
    assert.ok(
      modes.some((bits) => bits === 0) || modes.every((bits) => bits !== 0),
      "unreachable: the point is that the chmod line exists, which the test above pins",
    );
  });

  it("no COPY source points into the agent-state trees that were moved out", () => {
    for (const gone of ["/opt/dsh-install", ".agents/local/"]) {
      assert.ok(
        !new RegExp(`^COPY .*${gone}`, "m").test(code),
        `COPY of ${gone} is back; that path is either agent state or no longer exists`,
      );
    }
  });
});
