use serde::{Deserialize, Serialize};

pub const MAX_NEURONS: usize = 512;
pub const MAX_EVENTS_PER_CALL: usize = 100_000;
pub const MAX_NEURON_EVENTS_PER_CALL: usize = 2_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NeuronState {
    Receptive,
    Refractory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Model {
    #[serde(rename = "mone-v1")]
    MoneV1,
    #[serde(rename = "mone-initial-drive-v1")]
    MoneInitialDriveV1,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Parameters {
    pub threshold: f64,
    pub rest: f64,
    pub alpha: f64,
    pub refractory_period: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeuronConfig {
    pub id: String,
    pub potential: f64,
    pub state: NeuronState,
    #[serde(default)]
    pub initial_drive: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Connection {
    pub source: String,
    pub target: String,
    pub weight: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub schema_version: u32,
    pub model: Model,
    pub parameters: Parameters,
    pub neurons: Vec<NeuronConfig>,
    pub connections: Vec<Connection>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NeuronSnapshot {
    pub id: String,
    pub potential: f64,
    pub state: NeuronState,
    pub drive: f64,
    pub next_event_in: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub schema_version: u32,
    pub config: Config,
    pub time: f64,
    /// Low component of the compensated clock; exact time is approximately
    /// time + timeCorrection, without discarding sub-ULP event intervals.
    #[serde(default)]
    pub time_correction: f64,
    pub event_count: u64,
    pub neurons: Vec<NeuronSnapshot>,
    /// Row = source; column = target. Includes zero-weight/absent edges, as in
    /// the paper's indicator matrix; those entries have no dynamic effect.
    pub active_inputs: Vec<Vec<bool>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Event {
    pub time: f64,
    pub delta: f64,
    pub spikes: Vec<String>,
    pub recovered: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunResult {
    pub snapshot: Snapshot,
    pub events: Vec<Event>,
    pub halted: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Self(format!("Invalid JSON: {value}"))
    }
}

pub(crate) fn ensure(condition: bool, message: impl Into<String>) -> Result<(), Error> {
    if condition {
        Ok(())
    } else {
        Err(Error(message.into()))
    }
}
