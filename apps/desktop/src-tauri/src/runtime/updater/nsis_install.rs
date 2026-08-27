use std::{
    ffi::{OsStr, OsString},
    fmt,
    path::{Component, Path},
};

use super::download::{VerifiedInstallerArtifact, VerifiedInstallerIdentity};
use crate::app::update_install_exit::SealedInstallExit;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NsisInstallFailureStage {
    Plan,
    Spawn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NsisInstallError {
    stage: NsisInstallFailureStage,
    code: &'static str,
    retryable: bool,
    message: &'static str,
}

impl NsisInstallError {
    fn new(
        stage: NsisInstallFailureStage,
        code: &'static str,
        retryable: bool,
        message: &'static str,
    ) -> Self {
        Self {
            stage,
            code,
            retryable,
            message,
        }
    }

    fn platform_unsupported() -> Self {
        Self::new(
            NsisInstallFailureStage::Plan,
            "UPDATE_INSTALL_PLATFORM_UNSUPPORTED",
            false,
            "应用内更新只支持 Windows x64 current-user NSIS 安装包",
        )
    }

    fn path_rejected() -> Self {
        Self::new(
            NsisInstallFailureStage::Plan,
            "UPDATE_INSTALL_PATH_REJECTED",
            false,
            "已验证安装包路径不符合本机 NSIS cache 约束",
        )
    }

    fn identity_mismatch() -> Self {
        Self::new(
            NsisInstallFailureStage::Plan,
            "UPDATE_INSTALL_IDENTITY_MISMATCH",
            false,
            "已验证安装包与当前更新候选身份不一致",
        )
    }

    fn arguments_rejected() -> Self {
        Self::new(
            NsisInstallFailureStage::Plan,
            "UPDATE_INSTALL_ARGUMENTS_REJECTED",
            false,
            "应用重启参数未通过本地白名单",
        )
    }

    fn spawn_failed() -> Self {
        Self::new(
            NsisInstallFailureStage::Spawn,
            "UPDATE_INSTALL_SPAWN_FAILED",
            true,
            "无法启动已验证的更新安装包",
        )
    }

    pub(crate) fn stage(&self) -> NsisInstallFailureStage {
        self.stage
    }

    pub(crate) fn code(&self) -> &'static str {
        self.code
    }

    pub(crate) fn retryable(&self) -> bool {
        self.retryable
    }

    pub(crate) fn message(&self) -> &'static str {
        self.message
    }
}

impl fmt::Display for NsisInstallError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for NsisInstallError {}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct NsisSpawnPortError;

impl NsisSpawnPortError {
    pub(crate) fn new() -> Self {
        Self
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct NsisSpawnRequest<'a> {
    installer_path: &'a Path,
    raw_parameters: &'a OsStr,
}

impl<'a> NsisSpawnRequest<'a> {
    pub(crate) fn installer_path(self) -> &'a Path {
        self.installer_path
    }

    pub(crate) fn raw_parameters(self) -> &'a OsStr {
        self.raw_parameters
    }
}

/// Windows Adapter 必须把 `raw_parameters` 当作已经冻结的原生命令行参数串，
/// 使用普通 current-user process creation；不得改写参数、追加 switch 或使用 `runas`。
pub(crate) trait NsisInstallerSpawnPort: Send + Sync {
    fn spawn(&self, request: NsisSpawnRequest<'_>) -> Result<(), NsisSpawnPortError>;
}

#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct CurrentUserNsisSpawnPort;

#[cfg(windows)]
impl NsisInstallerSpawnPort for CurrentUserNsisSpawnPort {
    fn spawn(&self, request: NsisSpawnRequest<'_>) -> Result<(), NsisSpawnPortError> {
        use std::{os::windows::process::CommandExt, process::Command};

        // raw_parameters 已由 NsisInstallPlan 冻结；使用普通 CreateProcess/current-user
        // token，不经过 ShellExecute、runas 或 caller 提供的参数拼接。
        Command::new(request.installer_path())
            .raw_arg(request.raw_parameters())
            .spawn()
            .map(|_| ())
            .map_err(|_| NsisSpawnPortError::new())
    }
}

#[cfg(not(windows))]
impl NsisInstallerSpawnPort for CurrentUserNsisSpawnPort {
    fn spawn(&self, _request: NsisSpawnRequest<'_>) -> Result<(), NsisSpawnPortError> {
        Err(NsisSpawnPortError::new())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LocalRelaunchArguments {
    arguments: Vec<OsString>,
}

impl LocalRelaunchArguments {
    /// 当前产品没有对外承诺的命令行启动参数，因此白名单默认拒绝全部非空参数。
    /// 新增参数时必须先在这里显式建模并补齐 round-trip 测试。
    pub(crate) fn capture_current_process() -> Result<Self, NsisInstallError> {
        let arguments = std::env::args_os().skip(1).collect::<Vec<_>>();
        if arguments.is_empty() {
            Ok(Self { arguments })
        } else {
            Err(NsisInstallError::arguments_rejected())
        }
    }

    /// CI-only Draft smoke 不是产品进程，其 CLI 参数不得被候选应用继承。
    #[cfg(feature = "updater-smoke")]
    pub(crate) fn none_for_smoke() -> Self {
        Self {
            arguments: Vec::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn none_for_test() -> Self {
        Self {
            arguments: Vec::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn untrusted_for_test(
        arguments: impl IntoIterator<Item = impl Into<OsString>>,
    ) -> Self {
        Self {
            arguments: arguments.into_iter().map(Into::into).collect(),
        }
    }
}

#[must_use = "安装计划必须被消费为 spawn 结果或显式丢弃"]
#[derive(Debug)]
pub(crate) struct NsisInstallPlan {
    artifact: VerifiedInstallerArtifact,
    raw_parameters: OsString,
}

#[must_use = "spawn token 必须交给 sealed install exit 事务消费"]
#[derive(Debug)]
pub(crate) struct SealedSpawnedInstaller {
    sealed_exit: Box<SealedInstallExit>,
}

impl SealedSpawnedInstaller {
    /// spawn 成功后的唯一动作；不返回错误、不等待、不取得新锁。
    pub(crate) fn commit_after_spawn(self) {
        self.sealed_exit.commit_after_spawn();
    }
}

pub(crate) struct SealedNsisSpawnFailure {
    error: NsisInstallError,
    sealed_exit: Box<SealedInstallExit>,
}

impl SealedNsisSpawnFailure {
    pub(crate) fn error(&self) -> &NsisInstallError {
        &self.error
    }

    pub(crate) fn into_sealed_exit(self) -> Box<SealedInstallExit> {
        self.sealed_exit
    }
}

fn escape_nsis_relaunch_argument(argument: &OsStr) -> Result<OsString, NsisInstallError> {
    let argument = argument
        .to_str()
        .ok_or_else(NsisInstallError::arguments_rejected)?;
    if argument.encode_utf16().count() > 4_096
        || argument
            .chars()
            .any(|character| character == '\0' || (character.is_control() && character != '\t'))
    {
        return Err(NsisInstallError::arguments_rejected());
    }

    // 与 tauri-plugin-updater 2.10.0 的 NSIS escaping 保持一致；额外的
    // `/` quote 可防止 relaunch 参数被 NSIS 误判为安装器 switch。
    let quote = argument.is_empty()
        || argument
            .chars()
            .any(|character| matches!(character, ' ' | '\t' | '/'));
    let mut escaped = String::new();
    if quote {
        escaped.push('"');
    }
    let mut backslashes = 0_usize;
    for character in argument.chars() {
        if character == '\\' {
            backslashes += 1;
        } else {
            if character == '"' {
                escaped.extend(std::iter::repeat_n('\\', backslashes + 1));
            }
            backslashes = 0;
        }
        escaped.push(character);
    }
    if quote {
        escaped.extend(std::iter::repeat_n('\\', backslashes));
        escaped.push('"');
    }
    Ok(OsString::from(escaped))
}

impl NsisInstallPlan {
    /// `VerifiedInstallerIdentity` 只能由固定 Windows x64/current-user/NSIS
    /// provenance 产生；这里再绑定 exact cache artifact，防止 stale candidate 被启动。
    pub(crate) fn from_verified_artifact(
        artifact: &VerifiedInstallerArtifact,
        expected_identity: &VerifiedInstallerIdentity,
        relaunch_arguments: LocalRelaunchArguments,
    ) -> Result<Self, NsisInstallError> {
        if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            return Err(NsisInstallError::platform_unsupported());
        }
        if !artifact.path().is_absolute()
            || artifact.path().file_name() != Some(OsStr::new("installer.exe"))
            || artifact
                .path()
                .components()
                .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        {
            return Err(NsisInstallError::path_rejected());
        }
        if artifact.identity() != expected_identity {
            return Err(NsisInstallError::identity_mismatch());
        }
        if !relaunch_arguments.arguments.is_empty() {
            return Err(NsisInstallError::arguments_rejected());
        }
        Ok(Self {
            artifact: artifact.clone(),
            raw_parameters: build_nsis_parameters(&relaunch_arguments.arguments)?,
        })
    }

    pub(crate) fn installer_path(&self) -> &Path {
        self.artifact.path()
    }

    pub(crate) fn identity(&self) -> &VerifiedInstallerIdentity {
        self.artifact.identity()
    }

    pub(crate) fn raw_parameters(&self) -> &OsStr {
        &self.raw_parameters
    }

    /// 生产 spawn 必须同时消费 sealed exit capability。失败时 capability 原样返回，
    /// 供 coordinator 在 installer 尚未启动的边界内执行完整补偿。
    pub(crate) fn spawn_with_sealed_exit(
        self,
        sealed_exit: Box<SealedInstallExit>,
        port: &dyn NsisInstallerSpawnPort,
    ) -> Result<SealedSpawnedInstaller, SealedNsisSpawnFailure> {
        if port
            .spawn(NsisSpawnRequest {
                installer_path: self.artifact.path(),
                raw_parameters: &self.raw_parameters,
            })
            .is_err()
        {
            return Err(SealedNsisSpawnFailure {
                error: NsisInstallError::spawn_failed(),
                sealed_exit,
            });
        }
        Ok(SealedSpawnedInstaller { sealed_exit })
    }

    #[cfg(test)]
    fn spawn_for_test(
        self,
        port: &dyn NsisInstallerSpawnPort,
    ) -> Result<VerifiedInstallerIdentity, NsisInstallError> {
        port.spawn(NsisSpawnRequest {
            installer_path: self.artifact.path(),
            raw_parameters: &self.raw_parameters,
        })
        .map_err(|_| NsisInstallError::spawn_failed())?;
        Ok(self.artifact.identity().clone())
    }
}

fn build_nsis_parameters(relaunch_arguments: &[OsString]) -> Result<OsString, NsisInstallError> {
    const MAX_PARAMETER_UTF16_UNITS: usize = 30_000;

    let mut parameters = String::from("/P /R /UPDATE /ARGS");
    for argument in relaunch_arguments {
        parameters.push(' ');
        parameters.push_str(
            escape_nsis_relaunch_argument(argument)?
                .to_str()
                .ok_or_else(NsisInstallError::arguments_rejected)?,
        );
        if parameters.encode_utf16().count() > MAX_PARAMETER_UTF16_UNITS {
            return Err(NsisInstallError::arguments_rejected());
        }
    }
    Ok(OsString::from(parameters))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::updater::provenance::ReleaseCandidateId;
    use std::{path::PathBuf, sync::Mutex};

    #[derive(Debug, Clone, PartialEq, Eq)]
    struct RecordedSpawn {
        installer_path: PathBuf,
        raw_parameters: OsString,
    }

    #[derive(Default)]
    struct FakeSpawnPort {
        requests: Mutex<Vec<RecordedSpawn>>,
        fail: bool,
    }

    impl NsisInstallerSpawnPort for FakeSpawnPort {
        fn spawn(&self, request: NsisSpawnRequest<'_>) -> Result<(), NsisSpawnPortError> {
            self.requests
                .lock()
                .expect("fake spawn requests poisoned")
                .push(RecordedSpawn {
                    installer_path: request.installer_path().to_path_buf(),
                    raw_parameters: request.raw_parameters().to_os_string(),
                });
            if self.fail {
                Err(NsisSpawnPortError::new())
            } else {
                Ok(())
            }
        }
    }

    #[test]
    fn verified_installer_builds_fixed_passive_current_user_nsis_plan() {
        let path = std::env::temp_dir()
            .join("mineradio-nsis-plan")
            .join("installer.exe");
        let artifact = VerifiedInstallerArtifact::fake_at(
            ReleaseCandidateId::fake("candidate-a"),
            path.clone(),
        );
        let expected_identity = artifact.identity().clone();

        let plan = NsisInstallPlan::from_verified_artifact(
            &artifact,
            &expected_identity,
            LocalRelaunchArguments::none_for_test(),
        )
        .expect("受信安装包应形成 NSIS 计划");

        assert_eq!(plan.installer_path(), path);
        assert_eq!(plan.identity(), &expected_identity);
        assert_eq!(plan.raw_parameters(), OsStr::new("/P /R /UPDATE /ARGS"));
        assert!(!plan
            .raw_parameters()
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("runas"));
    }

    #[test]
    fn relative_installer_path_is_rejected_before_spawn() {
        let artifact = VerifiedInstallerArtifact::fake_at(
            ReleaseCandidateId::fake("candidate-a"),
            PathBuf::from("cache-v1/installer.exe"),
        );
        let expected_identity = artifact.identity().clone();

        let error = NsisInstallPlan::from_verified_artifact(
            &artifact,
            &expected_identity,
            LocalRelaunchArguments::none_for_test(),
        )
        .expect_err("相对路径不得进入安装计划");

        assert_eq!(error.code(), "UPDATE_INSTALL_PATH_REJECTED");
    }

    #[test]
    fn only_canonical_installer_exe_path_identity_is_accepted() {
        let root = std::env::temp_dir().join("mineradio-nsis-plan");
        for rejected in [
            root.join("installer.msi"),
            root.join("other.exe"),
            root.join("INSTALLER.EXE"),
            root.join("nested").join("..").join("installer.exe"),
        ] {
            let artifact = VerifiedInstallerArtifact::fake_at(
                ReleaseCandidateId::fake("candidate-a"),
                rejected,
            );
            let expected_identity = artifact.identity().clone();

            let error = NsisInstallPlan::from_verified_artifact(
                &artifact,
                &expected_identity,
                LocalRelaunchArguments::none_for_test(),
            )
            .expect_err("非 canonical installer.exe 不得进入安装计划");

            assert_eq!(error.code(), "UPDATE_INSTALL_PATH_REJECTED");
        }
    }

    #[test]
    fn cache_artifact_must_match_the_exact_expected_identity() {
        let path = std::env::temp_dir()
            .join("mineradio-nsis-plan")
            .join("installer.exe");
        let artifact = VerifiedInstallerArtifact::fake_at(
            ReleaseCandidateId::fake("candidate-a"),
            path.clone(),
        );
        let other =
            VerifiedInstallerArtifact::fake_at(ReleaseCandidateId::fake("candidate-b"), path);

        let error = NsisInstallPlan::from_verified_artifact(
            &artifact,
            other.identity(),
            LocalRelaunchArguments::none_for_test(),
        )
        .expect_err("candidate identity 不一致时必须 fail closed");

        assert_eq!(error.code(), "UPDATE_INSTALL_IDENTITY_MISMATCH");
    }

    #[test]
    fn non_allowlisted_local_relaunch_arguments_are_rejected() {
        let path = std::env::temp_dir()
            .join("mineradio-nsis-plan")
            .join("installer.exe");
        let artifact =
            VerifiedInstallerArtifact::fake_at(ReleaseCandidateId::fake("candidate-a"), path);
        let expected_identity = artifact.identity().clone();

        for unsafe_argument in [
            "--runtime-probe-test-child",
            "/S",
            "--arbitrary=manifest-controlled",
        ] {
            let error = NsisInstallPlan::from_verified_artifact(
                &artifact,
                &expected_identity,
                LocalRelaunchArguments::untrusted_for_test([unsafe_argument]),
            )
            .expect_err("未列入本地白名单的参数不得传给 NSIS");

            assert_eq!(error.code(), "UPDATE_INSTALL_ARGUMENTS_REJECTED");
        }
    }

    #[test]
    fn nsis_relaunch_argument_escaping_matches_tauri_updater_2_10_0() {
        let cases = [
            ("something", "something"),
            ("--flag", "--flag"),
            ("--empty=", "--empty="),
            ("--arg=value", "--arg=value"),
            ("some space", "\"some space\""),
            ("--arg value", "\"--arg value\""),
            ("--arg=unwrapped space", "\"--arg=unwrapped space\""),
            ("--arg=\"wrapped\"", "--arg=\\\"wrapped\\\""),
            ("--arg=\"wrapped space\"", "\"--arg=\\\"wrapped space\\\"\""),
            (
                "--arg=midword\"wrapped space\"",
                "\"--arg=midword\\\"wrapped space\\\"\"",
            ),
            ("", "\"\""),
            ("C:/Mine Radio/profile", "\"C:/Mine Radio/profile\""),
        ];

        for (plain, expected) in cases {
            assert_eq!(
                escape_nsis_relaunch_argument(OsStr::new(plain))
                    .expect("合法 Windows 参数应可编码"),
                OsString::from(expected),
                "escaping drifted for {plain:?}",
            );
        }
    }

    #[test]
    fn nsis_relaunch_argument_encoder_rejects_unsafe_windows_command_text() {
        for unsafe_argument in [
            OsString::from("contains\0nul"),
            OsString::from("contains\rreturn"),
            OsString::from("contains\nnewline"),
            OsString::from("x".repeat(4_097)),
        ] {
            let error = escape_nsis_relaunch_argument(&unsafe_argument)
                .expect_err("危险 Windows command text 必须被拒绝");
            assert_eq!(error.code(), "UPDATE_INSTALL_ARGUMENTS_REJECTED");
        }
    }

    #[test]
    fn complete_nsis_parameter_line_stays_below_windows_process_limit() {
        let oversized = vec![OsString::from("x".repeat(4_096)); 8];

        let error = build_nsis_parameters(&oversized)
            .expect_err("完整 command line 超预算时必须 fail closed");

        assert_eq!(error.code(), "UPDATE_INSTALL_ARGUMENTS_REJECTED");
    }

    #[test]
    fn successful_spawn_returns_exact_one_shot_installer_token() {
        let path = std::env::temp_dir()
            .join("mineradio-nsis-plan")
            .join("installer.exe");
        let artifact = VerifiedInstallerArtifact::fake_at(
            ReleaseCandidateId::fake("candidate-a"),
            path.clone(),
        );
        let expected_identity = artifact.identity().clone();
        let plan = NsisInstallPlan::from_verified_artifact(
            &artifact,
            &expected_identity,
            LocalRelaunchArguments::none_for_test(),
        )
        .unwrap();
        let port = FakeSpawnPort::default();

        let spawned = plan
            .spawn_for_test(&port)
            .expect("spawn success 应返回一次性 token");

        assert_eq!(&spawned, &expected_identity);
        assert_eq!(
            *port.requests.lock().unwrap(),
            vec![RecordedSpawn {
                installer_path: path,
                raw_parameters: OsString::from("/P /R /UPDATE /ARGS"),
            }]
        );
    }

    #[test]
    fn spawn_failure_returns_stable_error_without_exiting_the_process() {
        let path = std::env::temp_dir()
            .join("mineradio-nsis-plan")
            .join("installer.exe");
        let artifact =
            VerifiedInstallerArtifact::fake_at(ReleaseCandidateId::fake("candidate-a"), path);
        let expected_identity = artifact.identity().clone();
        let plan = NsisInstallPlan::from_verified_artifact(
            &artifact,
            &expected_identity,
            LocalRelaunchArguments::none_for_test(),
        )
        .unwrap();
        let port = FakeSpawnPort {
            requests: Mutex::new(Vec::new()),
            fail: true,
        };

        let error = plan
            .spawn_for_test(&port)
            .expect_err("spawn failure 必须返回 caller 触发 rollback");
        let process_is_still_running = true;

        assert_eq!(error.stage(), NsisInstallFailureStage::Spawn);
        assert_eq!(error.code(), "UPDATE_INSTALL_SPAWN_FAILED");
        assert!(error.retryable());
        assert_eq!(error.message(), "无法启动已验证的更新安装包");
        assert!(process_is_still_running);
        assert_eq!(port.requests.lock().unwrap().len(), 1);
    }
}
