//! Desktop Runtime 的有界、局部失败诊断聚合器。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::VecDeque, fmt, sync::Mutex};

pub const DIAGNOSTICS_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_RECENT_ERROR_LIMIT: usize = 32;
pub const DEFAULT_RECENT_EVENT_LIMIT: usize = 64;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticProbeKind {
    Runtime,
    Native,
    Window,
    Tray,
    Hotkeys,
    DesktopLyrics,
    FullDesktop,
    WallpaperEngine,
    Cache,
    Database,
    ProcessMemory,
    Visual,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticProbeStatus {
    Healthy,
    Unavailable,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticHealth {
    Healthy,
    Degraded,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DiagnosticIssueCode {
    ProbeFailed,
    SerializationFailed,
    RuntimeError,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticIssue {
    pub source: DiagnosticProbeKind,
    pub code: DiagnosticIssueCode,
    pub message: String,
    pub occurred_at_ms: u64,
}

/// 只包含稳定、低基数事实的结构化运行时事件。
///
/// `reason` 与 `error_code` 必须由调用方传入固定标识，不得放入路径、Cookie、媒体
/// URL、窗口标题或第三方 payload。可选字段省略后能保持诊断 JSON 紧凑。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StructuredDiagnosticEvent {
    pub event: String,
    pub phase: String,
    pub reason: String,
    pub generation: u64,
    pub occurred_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticProbe {
    pub kind: DiagnosticProbeKind,
    pub status: DiagnosticProbeStatus,
    pub captured_at_ms: u64,
    pub value: Option<Value>,
    pub message: Option<String>,
    pub error: Option<DiagnosticIssue>,
}

impl DiagnosticProbe {
    pub fn value<T: Serialize>(kind: DiagnosticProbeKind, captured_at_ms: u64, value: T) -> Self {
        match serde_json::to_value(value) {
            Ok(value) => Self {
                kind,
                status: DiagnosticProbeStatus::Healthy,
                captured_at_ms,
                value: Some(value),
                message: None,
                error: None,
            },
            Err(error) => Self::failed(
                kind,
                captured_at_ms,
                DiagnosticIssueCode::SerializationFailed,
                error,
            ),
        }
    }

    pub fn capture<T, E, F>(kind: DiagnosticProbeKind, captured_at_ms: u64, probe: F) -> Self
    where
        T: Serialize,
        E: fmt::Display,
        F: FnOnce() -> Result<T, E>,
    {
        match probe() {
            Ok(value) => Self::value(kind, captured_at_ms, value),
            Err(error) => Self::failed(
                kind,
                captured_at_ms,
                DiagnosticIssueCode::ProbeFailed,
                error,
            ),
        }
    }

    pub fn unavailable(
        kind: DiagnosticProbeKind,
        captured_at_ms: u64,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            status: DiagnosticProbeStatus::Unavailable,
            captured_at_ms,
            value: None,
            message: Some(message.into()),
            error: None,
        }
    }

    fn failed(
        kind: DiagnosticProbeKind,
        captured_at_ms: u64,
        code: DiagnosticIssueCode,
        error: impl fmt::Display,
    ) -> Self {
        let issue = DiagnosticIssue {
            source: kind,
            code,
            message: error.to_string(),
            occurred_at_ms: captured_at_ms,
        };
        Self {
            kind,
            status: DiagnosticProbeStatus::Failed,
            captured_at_ms,
            value: None,
            message: None,
            error: Some(issue),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    pub schema_version: u32,
    pub captured_at_ms: u64,
    pub health: DiagnosticHealth,
    pub probes: Vec<DiagnosticProbe>,
    pub recent_errors: Vec<DiagnosticIssue>,
    pub recent_events: Vec<StructuredDiagnosticEvent>,
}

#[derive(Debug)]
pub struct DiagnosticsRuntime {
    recent_error_limit: usize,
    recent_event_limit: usize,
    recent_errors: Mutex<VecDeque<DiagnosticIssue>>,
    recent_events: Mutex<VecDeque<StructuredDiagnosticEvent>>,
}

impl Default for DiagnosticsRuntime {
    fn default() -> Self {
        Self::new(DEFAULT_RECENT_ERROR_LIMIT)
    }
}

impl DiagnosticsRuntime {
    pub fn new(recent_error_limit: usize) -> Self {
        Self::new_with_limits(recent_error_limit, DEFAULT_RECENT_EVENT_LIMIT)
    }

    pub fn new_with_limits(recent_error_limit: usize, recent_event_limit: usize) -> Self {
        Self {
            recent_error_limit,
            recent_event_limit,
            recent_errors: Mutex::new(VecDeque::with_capacity(recent_error_limit)),
            recent_events: Mutex::new(VecDeque::with_capacity(recent_event_limit)),
        }
    }

    pub fn snapshot<I>(&self, captured_at_ms: u64, probes: I) -> DiagnosticsSnapshot
    where
        I: IntoIterator<Item = DiagnosticProbe>,
    {
        let probes: Vec<_> = probes.into_iter().collect();
        DiagnosticsSnapshot {
            schema_version: DIAGNOSTICS_SCHEMA_VERSION,
            captured_at_ms,
            health: health_for(&probes),
            recent_errors: self.snapshot_errors(&probes),
            recent_events: self.recent_events(),
            probes,
        }
    }

    fn snapshot_errors(&self, probes: &[DiagnosticProbe]) -> Vec<DiagnosticIssue> {
        if self.recent_error_limit == 0 {
            return Vec::new();
        }
        let mut errors = self.recent_errors();
        errors.extend(probes.iter().filter_map(|probe| probe.error.clone()));
        if errors.len() > self.recent_error_limit {
            errors.drain(..errors.len() - self.recent_error_limit);
        }
        errors
    }

    pub fn record_error(&self, issue: DiagnosticIssue) {
        if self.recent_error_limit == 0 {
            return;
        }
        let mut errors = self
            .recent_errors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while errors.len() >= self.recent_error_limit {
            errors.pop_front();
        }
        errors.push_back(issue);
    }

    pub fn record_runtime_error(
        &self,
        source: DiagnosticProbeKind,
        occurred_at_ms: u64,
        message: impl Into<String>,
    ) {
        self.record_error(DiagnosticIssue {
            source,
            code: DiagnosticIssueCode::RuntimeError,
            message: message.into(),
            occurred_at_ms,
        });
    }

    pub fn recent_errors(&self) -> Vec<DiagnosticIssue> {
        self.recent_errors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .cloned()
            .collect()
    }

    pub fn record_event(&self, event: StructuredDiagnosticEvent) {
        if self.recent_event_limit == 0 {
            return;
        }
        let mut events = self
            .recent_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        while events.len() >= self.recent_event_limit {
            events.pop_front();
        }
        events.push_back(event);
    }

    pub fn recent_events(&self) -> Vec<StructuredDiagnosticEvent> {
        self.recent_events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .iter()
            .cloned()
            .collect()
    }
}

fn health_for(probes: &[DiagnosticProbe]) -> DiagnosticHealth {
    if probes.is_empty()
        || probes
            .iter()
            .all(|probe| probe.status == DiagnosticProbeStatus::Unavailable)
    {
        DiagnosticHealth::Unavailable
    } else if probes
        .iter()
        .all(|probe| probe.status == DiagnosticProbeStatus::Healthy)
    {
        DiagnosticHealth::Healthy
    } else {
        DiagnosticHealth::Degraded
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn failed_probe_does_not_discard_other_probe_results() {
        let runtime = DiagnosticsRuntime::new(8);
        let probes = vec![
            DiagnosticProbe::value(
                DiagnosticProbeKind::Window,
                1_000,
                json!({ "visible": true }),
            ),
            DiagnosticProbe::capture::<Value, _, _>(DiagnosticProbeKind::Cache, 1_000, || {
                Err("缓存目录暂不可读")
            }),
            DiagnosticProbe::value(
                DiagnosticProbeKind::Tray,
                1_000,
                json!({ "status": "ready" }),
            ),
        ];

        let snapshot = runtime.snapshot(1_000, probes);

        assert_eq!(snapshot.probes.len(), 3);
        assert_eq!(snapshot.health, DiagnosticHealth::Degraded);
        assert_eq!(snapshot.probes[0].status, DiagnosticProbeStatus::Healthy);
        assert_eq!(snapshot.probes[1].status, DiagnosticProbeStatus::Failed);
        assert_eq!(snapshot.probes[2].status, DiagnosticProbeStatus::Healthy);
        assert_eq!(snapshot.recent_errors.len(), 1);
        assert_eq!(snapshot.recent_errors[0].source, DiagnosticProbeKind::Cache);
    }

    #[test]
    fn recent_error_history_is_bounded_and_keeps_the_newest_entries() {
        let runtime = DiagnosticsRuntime::new(2);
        for (source, at_ms) in [
            (DiagnosticProbeKind::Window, 1),
            (DiagnosticProbeKind::Cache, 2),
            (DiagnosticProbeKind::Tray, 3),
        ] {
            runtime.record_runtime_error(source, at_ms, format!("error-{at_ms}"));
        }

        let errors = runtime.recent_errors();

        assert_eq!(errors.len(), 2);
        assert_eq!(errors[0].source, DiagnosticProbeKind::Cache);
        assert_eq!(errors[1].source, DiagnosticProbeKind::Tray);
    }

    #[test]
    fn unavailable_probes_are_reported_without_becoming_errors() {
        let runtime = DiagnosticsRuntime::default();

        let snapshot = runtime.snapshot(
            5_000,
            [DiagnosticProbe::unavailable(
                DiagnosticProbeKind::Native,
                5_000,
                "当前平台不支持 native probe",
            )],
        );

        assert_eq!(snapshot.health, DiagnosticHealth::Unavailable);
        assert!(snapshot.recent_errors.is_empty());
        assert_eq!(
            snapshot.probes[0].status,
            DiagnosticProbeStatus::Unavailable
        );
    }

    #[test]
    fn diagnostic_reads_include_current_probe_failures_without_mutating_history() {
        let runtime = DiagnosticsRuntime::new(4);
        runtime.record_runtime_error(DiagnosticProbeKind::Runtime, 10, "启动阶段错误");
        let probes = [DiagnosticProbe::capture::<Value, _, _>(
            DiagnosticProbeKind::Cache,
            20,
            || Err("缓存快照暂不可读"),
        )];

        let first = runtime.snapshot(20, probes.clone());
        let second = runtime.snapshot(20, probes);

        assert_eq!(first, second);
        assert_eq!(runtime.recent_errors().len(), 1);
        assert_eq!(runtime.recent_errors()[0].message, "启动阶段错误");
        assert_eq!(first.recent_errors.len(), 2);
        assert_eq!(first.recent_errors[1].source, DiagnosticProbeKind::Cache);
    }

    #[test]
    fn structured_event_history_is_bounded_and_snapshot_reads_are_immutable() {
        let runtime = DiagnosticsRuntime::new_with_limits(4, 2);
        for generation in 1..=3 {
            runtime.record_event(StructuredDiagnosticEvent {
                event: "full_desktop_transition".into(),
                phase: "passive".into(),
                reason: "user_mode_request".into(),
                generation,
                occurred_at_ms: generation * 10,
                duration_ms: Some(2),
                error_code: None,
            });
        }

        let first = runtime.snapshot(40, []);
        let second = runtime.snapshot(40, []);

        assert_eq!(first, second);
        assert_eq!(first.recent_events.len(), 2);
        assert_eq!(first.recent_events[0].generation, 2);
        assert_eq!(first.recent_events[1].generation, 3);
        assert_eq!(runtime.recent_events().len(), 2);
    }

    #[test]
    fn structured_event_json_uses_stable_camel_case_fields_and_omits_absent_options() {
        let value = serde_json::to_value(StructuredDiagnosticEvent {
            event: "full_desktop_recovery_required".into(),
            phase: "recoveryRequired".into(),
            reason: "startup_recovery".into(),
            generation: 7,
            occurred_at_ms: 99,
            duration_ms: None,
            error_code: Some("JOURNAL".into()),
        })
        .expect("event serializes");

        assert_eq!(value["occurredAtMs"], 99);
        assert_eq!(value["errorCode"], "JOURNAL");
        assert!(value.get("durationMs").is_none());
    }
}
