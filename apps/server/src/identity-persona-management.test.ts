import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { IdentityPersonaManagement } from "./identity-persona-management.js";
import { ModuleTemplateError } from "./module-template-management.js";

function fixture() {
  const root = pathToFileURL(
    `${mkdtempSync(join(tmpdir(), "kaguya-persona-"))}/`,
  );
  writeFileSync(new URL("identity.name.default.hbs", root), "Kaguya");
  writeFileSync(new URL("identity.aliases.default.hbs", root), "辉夜");
  writeFileSync(new URL("identity.persona.default.hbs", root), "默认辉夜身份");
  return new IdentityPersonaManagement({
    root,
    exclusive: (operation) => operation(),
  });
}

describe("identity persona management", () => {
  it("saves with revision control and restores the default", async () => {
    const service = fixture();
    const initial = service.get();
    expect(initial.source).toBe("default");
    const saved = await service.change({
      revision: initial.revision,
      content: "本地辉夜身份",
    });
    expect(saved.source).toBe("local");
    expect(saved.effect).toBe("restart_required");
    await expect(
      service.change({ revision: initial.revision, content: "冲突" }),
    ).rejects.toMatchObject({ status: 409 });
    const restored = await service.change({ revision: saved.revision }, true);
    expect(restored.content).toBe("默认辉夜身份");
    expect(restored.source).toBe("default");
  });
  it("rejects empty and oversized templates", async () => {
    const service = fixture();
    const initial = service.get();
    await expect(
      service.change({ revision: initial.revision, content: "  " }),
    ).rejects.toBeInstanceOf(ModuleTemplateError);
    await expect(
      service.change({
        revision: initial.revision,
        content: "辉".repeat(50_000),
      }),
    ).rejects.toMatchObject({ code: "template_too_large" });
  });
  it("manages name and aliases as workspace resources", async () => {
    const service = fixture();
    const name = service.get("name");
    const savedName = await service.change(
      { revision: name.revision, content: "Luna" },
      false,
      "name",
    );
    expect(savedName.content).toBe("Luna");
    const aliases = service.get("aliases");
    await expect(
      service.change(
        { revision: aliases.revision, content: "Luna" },
        false,
        "aliases",
      ),
    ).rejects.toMatchObject({ code: "invalid_identity_resource" });
    const savedAliases = await service.change(
      { revision: aliases.revision, content: "月\nMoon\n月" },
      false,
      "aliases",
    );
    expect(savedAliases.content).toBe("月\nMoon\n月");
  });
});
