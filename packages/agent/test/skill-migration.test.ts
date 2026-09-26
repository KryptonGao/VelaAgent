import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { migrateExternalSkills, scanExternalSkills } from "../src/skill-migration.ts";

async function writeSkill(dir: string, body: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body);
}

describe("skill migration", () => {
  it("lists Codex and Claude Code skills and copies only the selected ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "vela-skill-migration-"));
    try {
      const home = join(root, "home");
      const cwd = join(root, "project");
      const skillsDir = join(home, ".vela", "skills");
      const outside = join(root, "outside", "evil");
      await writeSkill(join(home, ".codex", "skills", "apple-design"), [
        "---",
        "name: apple-design",
        "description: >-",
        "  Build fluid interfaces",
        "  with springs.",
        "---",
        "",
        "# Apple",
        "",
      ].join("\n"));
      await writeSkill(join(home, ".codex", "skills", ".system", "skill-creator"), "---\nname: skill-creator\ndescription: system\n---\n");
      await writeSkill(join(home, ".codex", "skills", "with-modules"), "---\nname: with-modules\ndescription: has extras\n---\n");
      await mkdir(join(home, ".codex", "skills", "with-modules", "node_modules", "pkg"), { recursive: true });
      await writeFile(join(home, ".codex", "skills", "with-modules", "node_modules", "pkg", "index.js"), "secret");
      const script = join(home, ".codex", "skills", "with-modules", "run.sh");
      await writeFile(script, "#!/bin/sh\n");
      await chmod(script, 0o755);
      await writeFile(join(home, ".codex", "skills", "with-modules", "notes.txt"), "keep");
      await symlink(join(root, "outside", "secret.txt"), join(home, ".codex", "skills", "with-modules", "secret.txt"));
      await writeSkill(outside, "---\nname: evil\ndescription: no\n---\n");
      await writeFile(join(root, "outside", "secret.txt"), "nope");
      await symlink(outside, join(home, ".codex", "skills", "escape"));

      await writeSkill(join(home, ".agents", "skills", "robin"), "---\nname: robin\ndescription: already loaded\n---\n");
      await mkdir(join(home, ".claude", "skills"), { recursive: true });
      await symlink(join(home, ".agents", "skills", "robin"), join(home, ".claude", "skills", "robin"));
      await writeSkill(join(home, ".claude", "skills", "quoted"), '---\nname: quoted\ndescription: "Use for UI review"\n---\n');
      await writeSkill(join(home, ".vela", "skills", "quoted"), "---\nname: quoted\ndescription: old copy\n---\n");
      await writeSkill(join(cwd, ".claude", "skills", "proj"), "---\nname: proj\ndescription: project skill\n---\n");
      await writeSkill(join(cwd, ".codex", "skills", "group", "child"), "---\nname: child\ndescription: nested\n---\n");
      await symlink(join(home, ".vela", "skills", "quoted"), join(home, ".claude", "skills", "same"));

      const scan = await scanExternalSkills({ home, cwd, skillsDir });
      const byId = new Map(scan.skills.map((skill) => [skill.id, skill]));

      assert.equal(scan.skills.some((skill) => skill.name === "skill-creator" || skill.id.includes(".system")), false);
      assert.equal(byId.has("codex:user:escape"), false);
      assert.equal(byId.get("codex:user:apple-design")?.description, "Build fluid interfaces with springs.");
      assert.equal(byId.get("codex:user:apple-design")?.state, "new");
      assert.equal(byId.get("codex:user:apple-design")?.selectable, true);
      assert.equal(byId.get("claude:user:robin")?.state, "loaded");
      assert.equal(byId.get("claude:user:robin")?.selectable, true);
      assert.equal(byId.get("claude:user:quoted")?.state, "present");
      assert.equal(byId.get("claude:user:quoted")?.description, "Use for UI review");
      assert.equal(byId.get("claude:user:same")?.selectable, false);
      assert.equal(byId.get("claude:project:proj")?.scope, "project");
      assert.equal(byId.get("codex:project:group/child")?.name, "child");

      const result = await migrateExternalSkills({ home, cwd, skillsDir }, [
        "codex:user:apple-design",
        "codex:user:with-modules",
        "claude:user:quoted",
        "claude:user:robin",
        "codex:user:missing",
        "codex:user:../outside",
      ]);

      assert.deepEqual(result.copied.map((entry) => entry.name).sort(), ["apple-design", "robin", "with-modules"]);
      assert.deepEqual(result.replaced.map((entry) => entry.name), ["quoted"]);
      assert.deepEqual(
        result.skipped.map((entry) => entry.reason).sort(),
        ["not-found", "not-found"],
      );
      assert.equal(await readFile(join(skillsDir, "apple-design", "SKILL.md"), "utf8"), await readFile(join(home, ".codex", "skills", "apple-design", "SKILL.md"), "utf8"));
      assert.equal(await readFile(join(skillsDir, "with-modules", "notes.txt"), "utf8"), "keep");
      assert.equal((await stat(join(skillsDir, "with-modules", "run.sh"))).mode & 0o777, 0o755);
      await assert.rejects(stat(join(skillsDir, "with-modules", "node_modules")));
      await assert.rejects(stat(join(skillsDir, "with-modules", "secret.txt")));
      assert.match(await readFile(join(skillsDir, "quoted", "SKILL.md"), "utf8"), /Use for UI review/);
      assert.match(await readFile(join(home, ".claude", "skills", "quoted", "SKILL.md"), "utf8"), /Use for UI review/);
      assert.equal((await lstat(join(home, ".codex", "skills", "apple-design"))).isDirectory(), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the first selected skill when two share a directory name", async () => {
    const root = await mkdtemp(join(tmpdir(), "vela-skill-migration-"));
    try {
      const home = join(root, "home");
      const cwd = join(root, "project");
      const skillsDir = join(home, ".vela", "skills");
      await writeSkill(join(home, ".codex", "skills", "pack", "tool"), "---\nname: codex-tool\ndescription: first\n---\n");
      await writeSkill(join(home, ".claude", "skills", "other", "tool"), "---\nname: claude-tool\ndescription: second\n---\n");

      const result = await migrateExternalSkills({ home, cwd, skillsDir }, [
        "codex:user:pack/tool",
        "claude:user:other/tool",
      ]);

      assert.deepEqual(result.copied.map((entry) => entry.name), ["codex-tool"]);
      assert.equal(result.skipped[0]?.reason, "duplicate");
      assert.match(await readFile(join(skillsDir, "tool", "SKILL.md"), "utf8"), /codex-tool/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
