import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkEnv } from "../lib/runners.ts";

function makeTempProject(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

test("checkEnv selects pnpm/yarn/bun runners for mainstream JS package managers", () => {
  const pnpmDir = makeTempProject("sentinel-pnpm");
  writeFileSync(join(pnpmDir, "package.json"), JSON.stringify({ packageManager: "pnpm@9.0.0" }));
  writeFileSync(join(pnpmDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'");

  const yarnDir = makeTempProject("sentinel-yarn");
  writeFileSync(join(yarnDir, "package.json"), JSON.stringify({ packageManager: "yarn@4.0.0" }));
  writeFileSync(join(yarnDir, "yarn.lock"), "");

  const bunDir = makeTempProject("sentinel-bun");
  writeFileSync(join(bunDir, "package.json"), JSON.stringify({}));
  writeFileSync(join(bunDir, "bun.lockb"), "");

  const pnpmEnv = checkEnv("typescript", pnpmDir);
  assert.equal(pnpmEnv.runner.depManager, "pnpm");
  assert.match(pnpmEnv.runner.installCmd, /pnpm install$/);
  assert.match(pnpmEnv.runner.testCmd, /pnpm .*vitest run \{testDir\}/);

  const yarnEnv = checkEnv("typescript", yarnDir);
  assert.equal(yarnEnv.runner.depManager, "yarn");
  assert.match(yarnEnv.runner.installCmd, /yarn install$/);
  assert.match(yarnEnv.runner.testCmd, /yarn vitest run \{testDir\}/);

  const bunEnv = checkEnv("typescript", bunDir);
  assert.equal(bunEnv.runner.depManager, "bun");
  assert.equal(bunEnv.runner.installCmd, "bun install");
  assert.equal(bunEnv.runner.testCmd, "bun x vitest run {testDir} --reporter=verbose --reporter=json --outputFile=vitest-results.json");
});

test("checkEnv selects poetry/pdm/uv and Java wrappers when present", () => {
  const poetryDir = makeTempProject("sentinel-poetry");
  writeFileSync(join(poetryDir, "pyproject.toml"), "[tool.poetry]\nname = \"demo\"\nversion = \"0.1.0\"\n");
  writeFileSync(join(poetryDir, "poetry.lock"), "");

  const pdmDir = makeTempProject("sentinel-pdm");
  writeFileSync(join(pdmDir, "pyproject.toml"), "[tool.pdm]\n");
  writeFileSync(join(pdmDir, "pdm.lock"), "");

  const uvDir = makeTempProject("sentinel-uv");
  writeFileSync(join(uvDir, "pyproject.toml"), "[project]\nname = \"demo\"\nversion = \"0.1.0\"\n");
  writeFileSync(join(uvDir, "uv.lock"), "");

  const gradleDir = makeTempProject("sentinel-gradle");
  writeFileSync(join(gradleDir, "build.gradle.kts"), "plugins {}");
  writeFileSync(join(gradleDir, "gradlew"), "#!/bin/sh\n");

  const mavenDir = makeTempProject("sentinel-maven");
  writeFileSync(join(mavenDir, "pom.xml"), "<project></project>");
  writeFileSync(join(mavenDir, "mvnw"), "#!/bin/sh\n");

  const poetryEnv = checkEnv("python", poetryDir);
  assert.equal(poetryEnv.runner.depManager, "poetry");
  assert.equal(poetryEnv.runner.installCmd, "poetry install");
  assert.equal(poetryEnv.runner.testCmd, "poetry run pytest {testDir} -v --tb=short");

  const pdmEnv = checkEnv("python", pdmDir);
  assert.equal(pdmEnv.runner.depManager, "pdm");
  assert.equal(pdmEnv.runner.installCmd, "pdm install");
  assert.equal(pdmEnv.runner.testCmd, "pdm run pytest {testDir} -v --tb=short");

  const uvEnv = checkEnv("python", uvDir);
  assert.equal(uvEnv.runner.depManager, "uv");
  assert.equal(uvEnv.runner.installCmd, "uv sync");
  assert.equal(uvEnv.runner.testCmd, "uv run pytest {testDir} -v --tb=short");

  const gradleEnv = checkEnv("java", gradleDir);
  assert.equal(gradleEnv.runner.depManager, "gradle");
  assert.equal(gradleEnv.runner.buildTool, "gradle");
  assert.equal(gradleEnv.runner.installCmd, "sh ./gradlew dependencies --quiet");
  assert.equal(gradleEnv.runner.testCmd, "sh ./gradlew test");

  const mavenEnv = checkEnv("java", mavenDir);
  assert.equal(mavenEnv.runner.depManager, "mvn");
  assert.equal(mavenEnv.runner.buildTool, "maven");
  assert.equal(mavenEnv.runner.installCmd, "sh ./mvnw dependency:resolve -q");
  assert.equal(mavenEnv.runner.testCmd, "sh ./mvnw test --batch-mode");
});
