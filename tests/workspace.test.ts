import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, destroyWorkspace } from "../lib/workspace.ts";

function makeTempProject(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

test("createWorkspace ignores exact directories without substring false positives", () => {
  const tsTarget = makeTempProject("sentinel-workspace-ts");
  mkdirSync(join(tsTarget, "dist"), { recursive: true });
  writeFileSync(join(tsTarget, "distill.ts"), "export const keep = 1;\n");
  writeFileSync(join(tsTarget, "dist", "skip.ts"), "export const skip = 1;\n");

  const tsWorkspace = createWorkspace(tsTarget, "typescript");
  try {
    assert.equal(existsSync(join(tsWorkspace.dir, "distill.ts")), true);
    assert.equal(existsSync(join(tsWorkspace.dir, "dist", "skip.ts")), false);
  } finally {
    destroyWorkspace(tsWorkspace);
  }

  const rubyTarget = makeTempProject("sentinel-workspace-ruby");
  mkdirSync(join(rubyTarget, "vendor", "bundle"), { recursive: true });
  writeFileSync(join(rubyTarget, "Gemfile"), "source \"https://rubygems.org\"\n");
  writeFileSync(join(rubyTarget, "vendorized.rb"), "class Keep; end\n");
  writeFileSync(join(rubyTarget, "vendor", "bundle", "skip.rb"), "class Skip; end\n");

  const rubyWorkspace = createWorkspace(rubyTarget, "ruby");
  try {
    assert.equal(existsSync(join(rubyWorkspace.dir, "vendorized.rb")), true);
    assert.equal(existsSync(join(rubyWorkspace.dir, "vendor", "bundle", "skip.rb")), false);
  } finally {
    destroyWorkspace(rubyWorkspace);
  }
});

test("createWorkspace supports wildcard ignore specs like *.egg-info without hiding normal files", () => {
  const pyTarget = makeTempProject("sentinel-workspace-py");
  mkdirSync(join(pyTarget, "demo.egg-info"), { recursive: true });
  writeFileSync(join(pyTarget, "pyproject.toml"), "[project]\nname = \"demo\"\nversion = \"0.1.0\"\n");
  writeFileSync(join(pyTarget, "main.py"), "print('hello')\n");
  writeFileSync(join(pyTarget, "egg-info-helper.py"), "print('keep')\n");
  writeFileSync(join(pyTarget, "demo.egg-info", "PKG-INFO"), "metadata\n");

  const pyWorkspace = createWorkspace(pyTarget, "python");
  try {
    assert.equal(existsSync(join(pyWorkspace.dir, "main.py")), true);
    assert.equal(existsSync(join(pyWorkspace.dir, "egg-info-helper.py")), true);
    assert.equal(existsSync(join(pyWorkspace.dir, "demo.egg-info", "PKG-INFO")), false);
  } finally {
    destroyWorkspace(pyWorkspace);
  }
});
