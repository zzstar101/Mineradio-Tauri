import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
// Windows checkout（core.autocrlf=true）会把 LF 规范化为 CRLF；
// 守卫断言的是内容结构而非换行字节，这里统一折叠后再匹配，CI（LF）行为不变。
const read = (path: string) =>
	readFileSync(resolve(root, path), "utf8").replaceAll("\r\n", "\n");

test("Draft source 只通过 updater-smoke feature 和专用 example 暴露", () => {
  const cargo = read("apps/desktop/src-tauri/Cargo.toml");
  const library = read("apps/desktop/src-tauri/src/lib.rs");
  const updater = read("apps/desktop/src-tauri/src/runtime/updater/mod.rs");

  expect(cargo).toContain("updater-smoke = []");
  expect(cargo).toContain('name = "updater-smoke"');
  expect(cargo).toContain('required-features = ["updater-smoke"]');
  expect(library).toContain('#[cfg(feature = "updater-smoke")]\npub mod updater_smoke;');
  expect(updater).toContain(
    '#[cfg(feature = "updater-smoke")]\npub(crate) mod draft_source;',
  );
});

test("公开 Tauri 构建不启用 updater-smoke feature", () => {
  const workflow = read(".github/workflows/protected-release.yml");
  const packageJson = read("package.json");
  const desktopPackage = read("apps/desktop/package.json");

  for (const productionSurface of [workflow, packageJson, desktopPackage]) {
    expect(productionSurface).not.toMatch(
      /tauri\s+build[^\r\n]*updater-smoke|updater-smoke[^\r\n]*tauri\s+build/,
    );
  }
});

test("CI-only Rust source 不读取 GitHub token，也不依赖 Sidecar runtime", () => {
  const harness = read("apps/desktop/src-tauri/src/updater_smoke.rs");
  const source = read(
    "apps/desktop/src-tauri/src/runtime/updater/draft_source.rs",
  );

  expect(source).not.toContain("GITHUB_TOKEN");
  expect(source).not.toContain("GH_TOKEN");
  expect(harness).toContain('std::env::var_os("GITHUB_TOKEN").is_none()');
  expect(harness).toContain('std::env::var_os("GH_TOKEN").is_none()');
  expect(harness).toContain("smoke harness 不得继承 GitHub token");
  for (const content of [harness, source]) {
    expect(content).not.toContain("crate::sidecar");
    expect(content).not.toContain("SidecarSupervisor");
    expect(content).not.toContain("SidecarRuntime");
    expect(content).not.toContain("sidecar_base_url");
  }
  expect(harness).toContain("struct SmokeNativeInstallOwners;");
  // sidecar supervisor 门已随 rust-crate 迁移移除；
  // smoke 安装流程改走 UpdateInstallGate 门禁，断言之以防绕过
  expect(harness).toContain("UpdateInstallGate");
});

test("受保护发布必须先冻结 Draft、完成 N−1→N smoke，再公开 exact release", () => {
  const workflow = read(".github/workflows/protected-release.yml");

  expect(workflow).toContain("  stage-release-draft:");
  expect(workflow).toContain("  smoke-upgrade:");
  expect(workflow).toContain("  publish-release:");
  expect(workflow).toContain("  probe-public-release:");
  expect(workflow).toContain("scripts/ci/stage-release-draft.mjs");
  expect(workflow).toContain("scripts/ci/publish-release-draft.mjs");
  expect(workflow).not.toMatch(/scripts\/ci\/publish-release\.mjs\s/);
  expect(workflow).toContain("      - smoke-upgrade\n");
  expect(workflow).toContain(
    "RELEASE_ID: ${{ needs.stage-release-draft.outputs.release_id }}",
  );
  expect(workflow).toContain("--features updater-smoke");
  expect(workflow).toContain("--example updater-smoke");
  expect(workflow).toContain("scripts/ci/run-draft-upgrade-smoke.ps1");
  expect(workflow).toContain("scripts/ci/download-previous-release.mjs");
  expect(workflow).toContain("Verify N-1 installer signature before execution");
  expect(workflow).toContain("probe-public");
});

test("smoke worker 仅直接启动 N−1 fixture，候选安装必须由 Runtime 和 NSIS Adapter 触发", () => {
  const worker = read("scripts/ci/run-draft-upgrade-smoke.ps1");
  const harness = read("apps/desktop/src-tauri/src/updater_smoke.rs");
  const startProcessLines = worker
    .split(/\r?\n/)
    .filter((line) => line.includes("Start-Process"));

  expect(startProcessLines).toEqual([
    "    $previousInstall = Start-Process -FilePath $PreviousInstaller -ArgumentList \"/S\" -PassThru -Wait",
  ]);
  expect(worker).toContain('"install-draft",');
  expect(worker).toContain('"verify-process-boundary"');
  expect(worker).toContain("if ($env:GITHUB_TOKEN -or $env:GH_TOKEN)");
  expect(worker).toContain("$boundary.processElevated -ne $false");
  expect(worker).toContain(
    "if ([version]$PreviousVersion -ge [version]$targetVersion)",
  );
  expect(worker).toContain("candidateRelaunched = $true");
  expect(worker).not.toMatch(/Start-Process[^\r\n]*(Draft|Candidate|targetVersion)/i);
  expect(harness).toContain('Some("install-draft")');
  expect(harness).toContain("UpdateRuntime::with_production_dependencies");
  expect(harness).toContain("RuntimeUpdateInstallerAdapter::new");
  expect(harness).toContain("CurrentUserNsisSpawnPort");
  expect(harness).toContain("run_pending_install_transaction");
});

test("标准用户只能修改独立 work 目录，发布输入和工具保持只读", () => {
  const workflow = read(".github/workflows/protected-release.yml");
  const worker = read("scripts/ci/run-draft-upgrade-smoke.ps1");

  expect(workflow).toContain('"inputs=$inputs"');
  expect(workflow).toContain('"work=$work"');
  expect(workflow).toContain("SMOKE_INPUTS: ${{ steps.paths.outputs.inputs }}");
  expect(workflow).toContain("SMOKE_WORK: ${{ steps.paths.outputs.work }}");
  expect(workflow).toContain("Protect-SmokeReadOnlyTree");
  expect(workflow).toContain("Protect-SmokeWritableTree");
  expect(workflow).toContain('"${smokePrincipal}:(OI)(CI)RX"');
  expect(workflow).toContain('"${smokePrincipal}:(OI)(CI)M"');
  expect(workflow).not.toContain(
    'icacls.exe $env:SMOKE_ROOT /grant:r "${account}:(OI)(CI)M" /T /C',
  );

  expect(worker).toContain("Assert-ReadOnlyFile");
  expect(worker).toContain("Assert-ReadOnlyDirectory");
  expect(worker).toContain('Assert-ReadOnlyDirectory $rootDirectory "smoke root"');
  expect(worker).toContain('Assert-ReadOnlyDirectory $inputsDirectory "smoke inputs"');
  expect(worker).toContain("$PSCommandPath");
  expect(worker).toContain("Split-Path -Parent $PreviousInstaller");
  expect(worker).toContain("Get-ChildItem -LiteralPath $toolsDirectory -File");
  expect(worker).toContain("Get-ChildItem -LiteralPath $DraftStaging -File");
});

test("创建标准用户 child 前清理 CI credential capability，child 和 Rust 边界再次 fail closed", () => {
  const workflow = read(".github/workflows/protected-release.yml");
  const worker = read("scripts/ci/run-draft-upgrade-smoke.ps1");

  expect(workflow).toContain("Remove-CredentialEnvironment");
  expect(workflow).toContain("ACTIONS_RUNTIME_TOKEN");
  expect(workflow).toContain("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  expect(workflow).toContain("GITHUB_ENV");
  expect(workflow).toContain("GITHUB_OUTPUT");
  expect(workflow).toContain("GITHUB_STATE");
  expect(workflow).toContain("GITHUB_STEP_SUMMARY");
  expect(workflow).toContain("$evidence.ciCredentialsAbsent -ne $true");
  expect(workflow.indexOf("Remove-CredentialEnvironment")).toBeLessThan(
    workflow.indexOf("Start-Process"),
  );

  expect(worker).toContain("Assert-CredentialEnvironmentAbsent");
  expect(worker).toContain("credential-like CI 环境变量");
  expect(worker.indexOf("Assert-CredentialEnvironmentAbsent")).toBeLessThan(
    worker.indexOf('Invoke-SmokeHarness @("verify-process-boundary")'),
  );
  expect(worker).toContain("$boundary.githubTokenAbsent -ne $true");
  expect(worker).toContain("$boundary.ghTokenAbsent -ne $true");
  expect(worker).toContain("$boundary.ciCredentialsAbsent -ne $true");
  expect(worker).toContain("ciCredentialsAbsent = [bool] $boundary.ciCredentialsAbsent");
});

test("publish 只接受本次 smoke 的 exact bounded evidence 和 candidate identity", () => {
  const workflow = read(".github/workflows/protected-release.yml");

  expect(workflow).toContain(
    "evidence_sha256: ${{ steps.smoke.outputs.evidence_sha256 }}",
  );
  expect(workflow).toContain('"evidence_sha256=$evidenceSha256"');
  expect(workflow).toContain('$evidence.releaseTag -cne $env:GITHUB_REF_NAME');
  expect(workflow).toContain('$evidence.commitSha -cne $env:GITHUB_SHA');
  expect(workflow).toContain('$evidence.targetVersion -cne $targetVersion');
  expect(workflow).toContain('$evidence.previousVersion -cne $env:PREVIOUS_VERSION');
  expect(workflow).toContain(
    "if ([version]$env:PREVIOUS_VERSION -ge [version]$targetVersion)",
  );
  expect(workflow).toContain("$evidence.candidateId -notmatch '^[0-9a-f]{64}$'");
  expect(workflow).toContain("$evidence.ciCredentialsAbsent -ne $true");

  expect(workflow).toContain("- name: Download bounded smoke evidence");
  expect(workflow).toContain(
    "name: updater-smoke-evidence-${{ github.run_attempt }}",
  );
  expect(workflow).toContain(
    "EVIDENCE_SHA256: ${{ needs.smoke-upgrade.outputs.evidence_sha256 }}",
  );
  expect(workflow).toContain(
    "EVIDENCE_ARTIFACT_DIGEST: ${{ needs.smoke-upgrade.outputs.evidence_artifact_digest }}",
  );
  expect(workflow).toContain(
    "EXPECTED_CANDIDATE_ID: ${{ needs.smoke-upgrade.outputs.candidate_id }}",
  );
  expect(workflow).toContain(
    "EXPECTED_PREVIOUS_VERSION: ${{ needs.smoke-upgrade.outputs.previous_version }}",
  );
  expect(workflow).toContain(
    "EXPECTED_TARGET_VERSION: ${{ needs.smoke-upgrade.outputs.target_version }}",
  );
  expect(workflow).toContain(
    "if ([version]$env:EXPECTED_PREVIOUS_VERSION -ge [version]$env:EXPECTED_TARGET_VERSION)",
  );
  expect(workflow).toContain(
    "$env:EVIDENCE_ARTIFACT_DIGEST -notmatch '^[0-9a-f]{64}$'",
  );
  expect(workflow).toContain("$actualEvidenceSha256 -cne $env:EVIDENCE_SHA256");
  expect(workflow).toMatch(
    /scripts\/ci\/publish-release-draft\.mjs `\r?\n\s+\$env:RELEASE_ID `\r?\n\s+\$env:EXPECTED_CANDIDATE_ID `\r?\n\s+--repository/,
  );
});

test("单体 publish CLI fail closed，只允许 split Draft wrapper 进入发布链", () => {
  const workflow = read(".github/workflows/protected-release.yml");
  const publish = read("scripts/ci/publish-release.mjs");
  const stage = read("scripts/ci/stage-release-draft.mjs");
  const finalize = read("scripts/ci/publish-release-draft.mjs");

  expect(publish).toContain("单体 publish CLI 已禁用");
  expect(publish).not.toContain("IMMUTABLE_RELEASES_READ_TOKEN");
  expect(workflow).not.toContain("IMMUTABLE_RELEASES_READ_TOKEN");
  expect(publish).toContain("if (release.immutable !== true)");
  expect(stage).toContain("prepareDraftRelease");
  expect(finalize).toContain("finalizeDraftRelease");
});
