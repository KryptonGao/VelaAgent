import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deleteSkill, readDisabledSkills, setSkillEnabled } from "../src/skill-management.ts";
import { loadSkillCatalog } from "../src/skill-catalog.ts";

async function writeSkill(dir: string, name: string, description = "test skill"): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
}

describe("skill management", () => {
  it("persists disabled skill names", async () => {
    const root = await mkdtemp(join(tmpdir(), "vela-skill-admin-"));
    try {
      const agentDir = join(root, ".vela");
      assert.deepEqual([...(await readDisabledSkills(agentDir))], []);

      await setSkillEnabled(agentDir, "alpha", false);
      await setSkillEnabled(agentDir, "beta", false);
      assert.deepEqual([...(await readDisabledSkills(agentDir))].sort(), ["alpha", "beta"]);

      await setSkillEnabled(agentDir, "alpha", true);
      assert.deepEqual([...(await readDisabledSkills(agentDir))], ["beta"]);
      assert.deepEqual(JSON.parse(await readFile(join(agentDir, "skill-preferences.json"), "utf8")), {
        disabled: ["beta"],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats a broken preferences file as empty and removes duplicates", async () => {
    const root = await mkdtemp(join(tmpdir(), "vela-skill-admin-"));
    try {
      const agentDir = join(root, ".vela");
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "skill-preferences.json"), "{ not json");
      assert.deepEqual([...(await readDisabledSkills(agentDir))], []);
      await writeFile(join(agentDir, "skill-preferences.json"), JSON.stringify({ disabled: ["a", "a", 3, " b "] }));
      assert.deepEqual([...(await readDisabledSkills(agentDir))], ["a", "b"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes skill folders and bare markdown files inside the Vela skills directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "vela-skill-admin-"));
    try {
      const agentDir = join(root, ".vela");
      const skillsDir = join(agentDir, "skills");
      await writeSkill(join(skillsDir, "alpha"), "alpha");
      await writeSkill(join(skillsDir, "group", "beta"), "beta");
      await writeFile(join(skillsDir, "gamma.md"), "---\nname: gamma\ndescription: bare file\n---\n");
      await setSkillEnabled(agentDir, "alpha", false);

      await deleteSkill({ agentDir, name: "alpha", location: join(skillsDir, "alpha", "SKILL.md") });
      assert.equal(existsSync(join(skillsDir, "alpha")), false);
      assert.equal((await readDisabledSkills(agentDir)).has("alpha"), false);

      await deleteSkill({ agentDir, name: "beta", location: join(skillsDir, "group", "beta", "SKILL.md") });
      assert.equal(existsSync(join(skillsDir, "group", "beta")), false);
      assert.equal(existsSync(join(skillsDir, "group")), true);

      await deleteSkill({ agentDir, name: "gamma", location: join(skillsDir, "gamma.md") });
      assert.equal(existsSync(join(skillsDir, "gamma.md")), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to delete anything outside the Vela skills directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "vela-skill-admin-"));
    try {
      const agentDir = join(root, ".vela");
      const skillsDir = join(agentDir, "skills");
      const outside = join(root, "outside", "evil");
      await writeSkill(outside, "evil");
      await writeFile(join(root, "outside", "evil.md"), "---\nname: evil\ndescription: no\n---\n");
      await mkdir(skillsDir, { recursive: true });

      await assert.rejects(
        () => deleteSkill({ agentDir, name: "evil", location: join(outside, "SKILL.md") }),
        /只能删除/,
      );
      await assert.rejects(
        () => deleteSkill({ agentDir, name: "evil", location: join(skillsDir, "..", "..", "outside", "evil.md") }),
        /只能删除/,
      );
      await assert.rejects(
        () => deleteSkill({ agentDir, name: "evil", location: join(outside, "SKILL.md").replace(/\.md$/, "") }),
        /只能删除/,
      );
      assert.equal(existsSync(join(outside, "SKILL.md")), true);
      assert.equal(existsSync(join(root, "outside", "evil.md")), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("removes a linked skill without deleting its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "vela-skill-admin-"));
    try {
      const agentDir = join(root, ".vela");
      const skillsDir = join(agentDir, "skills");
      const target = join(root, "somewhere", "linked");
      await writeSkill(target, "linked");
      await mkdir(skillsDir, { recursive: true });
      await symlink(target, join(skillsDir, "linked"));

      await deleteSkill({ agentDir, name: "linked", location: join(skillsDir, "linked", "SKILL.md") });
      assert.equal(existsSync(join(skillsDir, "linked")), false);
      assert.equal(existsSync(join(target, "SKILL.md")), true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a missing skill instead of deleting a folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "vela-skill-admin-"));
    try {
      const agentDir = join(root, ".vela");
      const skillsDir = join(agentDir, "skills");
      await mkdir(skillsDir, { recursive: true });
      await assert.rejects(
        () => deleteSkill({ agentDir, name: "missing", location: join(skillsDir, "missing", "SKILL.md") }),
        /找不到/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks disabled and deletable skills in the catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "vela-skill-admin-"));
    const previousHome = process.env.HOME;
    try {
      const home = join(root, "home");
      process.env.HOME = home;
      const agentDir = join(home, ".vela");
      const cwd = join(root, "project");
      await writeSkill(join(agentDir, "skills", "alpha"), "alpha");
      await writeSkill(join(home, ".agents", "skills", "shared"), "shared");
      await writeSkill(join(cwd, ".pi", "skills", "proj"), "proj");
      await setSkillEnabled(agentDir, "alpha", false);

      const catalog = await loadSkillCatalog({ cwd, agentDir });
      const byName = new Map(catalog.skills.map((skill) => [skill.name, skill]));
      assert.equal(catalog.skillsDir, join(agentDir, "skills"));
      assert.equal(byName.get("alpha")?.enabled, false);
      assert.equal(byName.get("alpha")?.canDelete, true);
      assert.equal(byName.get("shared")?.enabled, true);
      assert.equal(byName.get("shared")?.canDelete, false);
      assert.equal(byName.get("shared")?.origin, "agents");
      assert.equal(byName.get("proj")?.canDelete, false);
      assert.equal(byName.get("proj")?.origin, "project");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });
});
