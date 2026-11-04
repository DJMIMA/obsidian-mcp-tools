import { describe, expect, test } from "bun:test";
import { executableFolders, protectedFolders, targetRefusal, templateRefusal } from "./policy";

const folders = { templates: "Templates", userScripts: "Scripts" };

describe("protectedFolders", () => {
  test("lists templates, user scripts and prompts", () => {
    expect(protectedFolders(folders)).toEqual(["Templates", "Scripts", "Prompts"]);
  });

  test("drops unset folders and the vault root", () => {
    expect(protectedFolders({ templates: "/", userScripts: "" })).toEqual(["Prompts"]);
    expect(protectedFolders({})).toEqual(["Prompts"]);
  });

  test("trims the slashes Templater may store", () => {
    expect(protectedFolders({ templates: "/Templates/" })).toEqual(["Templates", "Prompts"]);
  });
});

describe("templateRefusal", () => {
  test("allows templates and prompts", () => {
    expect(templateRefusal("Templates/Daily Note Template.md", folders)).toBeNull();
    expect(templateRefusal("Prompts/summary.md", folders)).toBeNull();
  });

  // A note the model just wrote elsewhere must not run as a template.
  test("refuses any other note, and user scripts", () => {
    expect(templateRefusal("Inbox/evil.md", folders)).toContain("Only templates inside");
    expect(templateRefusal("Scripts/helper.md", folders)).toContain("Only templates inside");
  });

  test("with no template folder set, only prompts run", () => {
    expect(executableFolders({})).toEqual(["Prompts"]);
    expect(templateRefusal("Templates/x.md", {})).toContain('"Prompts/"');
  });
});

describe("targetRefusal", () => {
  test("allows an ordinary note", () => {
    expect(targetRefusal("Daily log/2026-11-04.md", folders)).toBeNull();
  });

  test("refuses traversal, hidden folders and backslashes", () => {
    expect(targetRefusal("../outside.md", folders)).toContain("'..'");
    expect(targetRefusal(".obsidian/plugins/x/main.js", folders)).toContain("hidden");
    expect(targetRefusal("..\\outside.md", folders)).toContain("backslash");
  });

  test("refuses protected folders, in any letter case", () => {
    expect(targetRefusal("templates/new.md", folders)).toContain('"Templates"');
    expect(targetRefusal("Scripts/x.md", folders)).toContain('"Scripts"');
    expect(targetRefusal("Prompts/x.md", folders)).toContain('"Prompts"');
  });
});
