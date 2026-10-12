//! An event-driven MONE simulator with an analytical, UI-independent core.
//! Time is advanced only to a spike or a refractory recovery. The input matrix
//! is binary memory, not a trainable weight matrix.

mod types;
mod validation;
#[cfg(feature = "wasm")]
mod wasm;

pub use types::*;
use validation::{validate_config, validate_potential, validate_snapshot};

const EVENT_RELATIVE_TOLERANCE: f64 = 64.0 * f64::EPSILON;
const MAX_SAFE_EVENT_COUNT: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug)]
struct RuntimeNeuron {
    potential: f64,
    state: NeuronState,
    drive: f64,
}

#[derive(Clone, Debug)]
pub struct Simulation {
    config: Config,
    weights: Vec<Vec<f64>>,
    neurons: Vec<RuntimeNeuron>,
    active_inputs: Vec<Vec<bool>>,
    // Canonical order makes summation independent of UI neuron ordering.
    source_order: Vec<usize>,
    time: f64,
    time_correction: f64,
    event_count: u64,
}

impl Simulation {
    pub fn new(config: Config) -> Result<Self, Error> {
        let weights = validate_config(&config)?;
        let n = config.neurons.len();
        let mut source_order: Vec<usize> = (0..n).collect();
        source_order.sort_by(|&a, &b| config.neurons[a].id.cmp(&config.neurons[b].id));
        let neurons = config
            .neurons
            .iter()
            .map(|item| RuntimeNeuron {
                potential: item.potential,
                state: item.state,
                drive: item.initial_drive,
            })
            .collect();
        let simulation = Self {
            config,
            weights,
            neurons,
            source_order,
            active_inputs: vec![vec![false; n]; n],
            time: 0.0,
            time_correction: 0.0,
            event_count: 0,
        };
        simulation.predictions()?;
        Ok(simulation)
    }

    pub fn from_json(json: &str) -> Result<Self, Error> {
        Self::new(serde_json::from_str(json)?)
    }

    /// Restore all dynamical state. nextEventIn is a display hint and is always
    /// recomputed: changing that hint cannot alter simulation dynamics.
    pub fn from_snapshot(snapshot: Snapshot) -> Result<Self, Error> {
        let mut simulation = Self::new(snapshot.config.clone())?;
        validate_snapshot(&snapshot)?;
        simulation.neurons = snapshot
            .neurons
            .into_iter()
            .map(|item| RuntimeNeuron {
                potential: item.potential,
                state: item.state,
                drive: item.drive,
            })
            .collect();
        simulation.active_inputs = snapshot.active_inputs;
        simulation.time = snapshot.time;
        simulation.time_correction = snapshot.time_correction;
        simulation.event_count = snapshot.event_count;
        simulation.predictions()?;
        Ok(simulation)
    }

    pub fn from_snapshot_json(json: &str) -> Result<Self, Error> {
        Self::from_snapshot(serde_json::from_str(json)?)
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    pub fn snapshot(&self) -> Result<Snapshot, Error> {
        let next = self.predictions()?;
        Ok(Snapshot {
            schema_version: 1,
            config: self.config.clone(),
            time: self.time,
            time_correction: self.time_correction,
            event_count: self.event_count,
            active_inputs: self.active_inputs.clone(),
            neurons: self
                .neurons
                .iter()
                .enumerate()
                .map(|(i, neuron)| NeuronSnapshot {
                    id: self.config.neurons[i].id.clone(),
                    potential: neuron.potential,
                    state: neuron.state,
                    drive: neuron.drive,
                    next_event_in: next[i],
                })
                .collect(),
        })
    }

    pub fn snapshot_json(&self) -> Result<String, Error> {
        Ok(serde_json::to_string(&self.snapshot()?)?)
    }

    /// Count is a number of event groups, not a duration or a spike count.
    /// A zero count is a read-only query. A quiet network stops immediately.
    pub fn step(&mut self, count: usize) -> Result<RunResult, Error> {
        ensure(
            count <= MAX_EVENTS_PER_CALL,
            format!("At most {MAX_EVENTS_PER_CALL} event groups per call"),
        )?;
        ensure(count * self.neurons.len() <= MAX_NEURON_EVENTS_PER_CALL,
            format!("Batch count × neuron count must be <= {MAX_NEURON_EVENTS_PER_CALL}; use smaller batches"))?;
        if count == 0 {
            return self.run_steps(0);
        }
        // A failed batch must not leave the caller with an outdated snapshot.
        // Static config/weights need no copy; only dynamic state is backed up.
        let checkpoint = (
            self.neurons.clone(),
            self.active_inputs.clone(),
            self.time,
            self.time_correction,
            self.event_count,
        );
        let result = self.run_steps(count);
        if result.is_err() {
            (
                self.neurons,
                self.active_inputs,
                self.time,
                self.time_correction,
                self.event_count,
            ) = checkpoint;
        }
        result
    }

    fn run_steps(&mut self, count: usize) -> Result<RunResult, Error> {
        let mut events = Vec::with_capacity(count.min(1024));
        for _ in 0..count {
            match self.next_event()? {
                Some(event) => events.push(event),
                None => break,
            }
        }
        let snapshot = self.snapshot()?;
        let halted = snapshot
            .neurons
            .iter()
            .all(|item| item.next_event_in.is_none());
        Ok(RunResult {
            snapshot,
            events,
            halted,
        })
    }

    pub fn step_json(&mut self, count: usize) -> Result<String, Error> {
        Ok(serde_json::to_string(&self.step(count)?)?)
    }

    fn equilibrium(&self, target: usize) -> f64 {
        // Compensated summation in canonical ID order. All terms are positive.
        let mut total = self.config.parameters.rest;
        let mut compensation = 0.0;
        let terms = std::iter::once(self.neurons[target].drive).chain(
            self.source_order.iter().filter_map(|&source| {
                self.active_inputs[source][target].then_some(self.weights[source][target])
            }),
        );
        for term in terms {
            let corrected = term - compensation;
            let next = total + corrected;
            compensation = (next - total) - corrected;
            total = next;
        }
        total
    }

    fn predictions(&self) -> Result<Vec<Option<f64>>, Error> {
        self.neurons.iter().enumerate().map(|(index, neuron)| {
            let parameters = &self.config.parameters;
            let delta = match neuron.state {
                NeuronState::Refractory => -neuron.potential * parameters.refractory_period,
                NeuronState::Receptive => {
                    let equilibrium = self.equilibrium(index);
                    ensure(equilibrium.is_finite(), "Numerical range exceeded in synaptic input")?;
                    if equilibrium <= parameters.threshold {
                        return Ok(None);
                    }
                    let numerator = parameters.threshold - neuron.potential;
                    let denominator = equilibrium - parameters.threshold;
                    let ratio = numerator / denominator;
                    let logarithm = if ratio.is_infinite() {
                        libm::log(numerator) - libm::log(denominator)
                    } else {
                        libm::log1p(ratio)
                    };
                    logarithm / parameters.alpha
                }
            };
            ensure(delta.is_finite() && delta > 0.0,
                format!("Event interval for {} is outside positive f64 range; rescale model parameters", self.config.neurons[index].id))?;
            Ok(Some(delta))
        }).collect()
    }

    fn next_event(&mut self) -> Result<Option<Event>, Error> {
        let predictions = self.predictions()?;
        let Some(delta) = predictions.iter().flatten().copied().reduce(f64::min) else {
            return Ok(None);
        };
        let (next_time, next_correction) = self.advance_clock(delta)?;
        ensure(
            self.event_count < MAX_SAFE_EVENT_COUNT,
            "Event count exceeds JSON safe integer range",
        )?;
        let is_event: Vec<bool> = predictions
            .iter()
            .map(|candidate| {
                candidate.is_some_and(|t| {
                    (t - delta).abs() <= EVENT_RELATIVE_TOLERANCE * t.abs().max(delta.abs())
                })
            })
            .collect();
        // Freeze the entire group before mutating any input or state.
        let mut next_neurons = self.neurons.clone();
        let mut event = Event {
            time: next_time,
            delta,
            spikes: Vec::new(),
            recovered: Vec::new(),
        };
        for (index, neuron) in next_neurons.iter_mut().enumerate() {
            if is_event[index] {
                match neuron.state {
                    NeuronState::Refractory => {
                        neuron.state = NeuronState::Receptive;
                        neuron.potential = 0.0;
                        event.recovered.push(self.config.neurons[index].id.clone());
                    }
                    NeuronState::Receptive => {
                        neuron.state = NeuronState::Refractory;
                        neuron.potential = -1.0;
                        neuron.drive = 0.0;
                        event.spikes.push(self.config.neurons[index].id.clone());
                    }
                }
            } else {
                self.advance_neuron(index, neuron, delta)?;
            }
        }
        // Both passes use the pre-event states. Clearing the column first means
        // a target recovering now receives sources that spike at this instant.
        for (target, old) in self.neurons.iter().enumerate() {
            if is_event[target] && old.state == NeuronState::Refractory {
                for row in &mut self.active_inputs {
                    row[target] = false;
                }
            }
        }
        for (source, old) in self.neurons.iter().enumerate() {
            if is_event[source] && old.state == NeuronState::Receptive {
                self.active_inputs[source].fill(true);
            }
        }
        self.neurons = next_neurons;
        self.time = next_time;
        self.time_correction = next_correction;
        self.event_count += 1;
        Ok(Some(event))
    }

    fn advance_clock(&self, delta: f64) -> Result<(f64, f64), Error> {
        // TwoSum captures the roundoff of adding the local positive interval.
        // A second normalization retains the low part across arbitrarily sized
        // batches and snapshots. Causally distinct events may share a rounded
        // timestamp; their order and positive delta remain available to callers.
        let sum = self.time + delta;
        ensure(sum.is_finite(), "Event time exceeds f64 range")?;
        let virtual_delta = sum - self.time;
        let roundoff = (self.time - (sum - virtual_delta)) + (delta - virtual_delta);
        let correction = self.time_correction + roundoff;
        let time = sum + correction;
        let correction = correction - (time - sum);
        ensure(
            time.is_finite() && correction.is_finite() && time >= self.time,
            "Compensated event time is outside finite nondecreasing range",
        )?;
        ensure(time != self.time || correction != self.time_correction,
            "Event time cannot advance at compensated f64 precision; rescale time or shorten the run")?;
        Ok((time, correction))
    }

    fn advance_neuron(
        &self,
        index: usize,
        neuron: &mut RuntimeNeuron,
        delta: f64,
    ) -> Result<(), Error> {
        let parameters = &self.config.parameters;
        neuron.potential = match neuron.state {
            NeuronState::Refractory => neuron.potential + delta / parameters.refractory_period,
            NeuronState::Receptive => {
                let equilibrium = self.equilibrium(index);
                neuron.potential
                    - (equilibrium - neuron.potential) * libm::expm1(-parameters.alpha * delta)
            }
        };
        // If a subthreshold, asymptotic trajectory rounds to the threshold,
        // preserve the open state interval instead of inventing a spike.
        if neuron.state == NeuronState::Receptive && neuron.potential >= parameters.threshold {
            let excess = neuron.potential - parameters.threshold;
            ensure(
                excess <= EVENT_RELATIVE_TOLERANCE * parameters.threshold,
                "Numerical error: receptive potential crossed an unselected event",
            )?;
            neuron.potential = f64::from_bits(parameters.threshold.to_bits() - 1);
        }
        validate_potential(neuron.state, neuron.potential, parameters.threshold)
    }
}
