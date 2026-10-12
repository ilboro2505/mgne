use crate::types::*;
use std::collections::{HashMap, HashSet};

pub(crate) fn validate_config(config: &Config) -> Result<Vec<Vec<f64>>, Error> {
    ensure(
        config.schema_version == 1,
        "Unsupported config schemaVersion; expected 1",
    )?;
    let p = &config.parameters;
    for (name, value) in [
        ("threshold", p.threshold),
        ("rest", p.rest),
        ("alpha", p.alpha),
        ("refractoryPeriod", p.refractory_period),
    ] {
        ensure(
            value.is_finite() && value > 0.0,
            format!("{name} must be finite and positive"),
        )?;
    }
    let n = config.neurons.len();
    ensure(
        (1..=MAX_NEURONS).contains(&n),
        format!("Expected 1..={MAX_NEURONS} neurons"),
    )?;
    ensure(
        config.connections.len() <= n * (n - 1),
        "Too many connections",
    )?;
    let mut ids = HashMap::with_capacity(n);
    for (index, neuron) in config.neurons.iter().enumerate() {
        ensure(
            !neuron.id.trim().is_empty() && neuron.id.len() <= 128,
            "Neuron IDs must be nonempty and at most 128 UTF-8 bytes",
        )?;
        ensure(
            ids.insert(neuron.id.as_str(), index).is_none(),
            format!("Duplicate neuron ID: {}", neuron.id),
        )?;
        validate_potential(neuron.state, neuron.potential, p.threshold.min(p.rest))?;
        ensure(
            neuron.initial_drive.is_finite() && neuron.initial_drive >= 0.0,
            "initialDrive must be finite and nonnegative",
        )?;
        ensure(
            config.model != Model::MoneV1 || neuron.initial_drive == 0.0,
            "Nonzero initialDrive requires model mone-initial-drive-v1",
        )?;
    }
    let mut weights = vec![vec![0.0; n]; n];
    let mut edges = HashSet::with_capacity(config.connections.len());
    for edge in &config.connections {
        let source = *ids
            .get(edge.source.as_str())
            .ok_or_else(|| Error(format!("Unknown source: {}", edge.source)))?;
        let target = *ids
            .get(edge.target.as_str())
            .ok_or_else(|| Error(format!("Unknown target: {}", edge.target)))?;
        ensure(source != target, "Self connections are not allowed")?;
        ensure(edges.insert((source, target)), "Duplicate connection")?;
        ensure(
            edge.weight.is_finite() && edge.weight >= 0.0,
            "Weights must be finite and nonnegative",
        )?;
        weights[source][target] = edge.weight;
    }
    // Every possible input combination must have a representable equilibrium.
    for target in 0..n {
        let total = weights
            .iter()
            .fold(p.rest + config.neurons[target].initial_drive, |sum, row| {
                sum + row[target]
            });
        ensure(
            total.is_finite(),
            "Total incoming weight + rest + drive exceeds f64 range",
        )?;
    }
    Ok(weights)
}

pub(crate) fn validate_potential(
    state: NeuronState,
    potential: f64,
    upper: f64,
) -> Result<(), Error> {
    ensure(potential.is_finite(), "Potential must be finite")?;
    match state {
        NeuronState::Receptive => ensure(
            potential >= 0.0 && potential < upper,
            format!("Receptive potential must be in [0, {upper})"),
        ),
        NeuronState::Refractory => ensure(
            (-1.0..0.0).contains(&potential),
            "Refractory potential must be in [-1, 0)",
        ),
    }
}

pub(crate) fn validate_snapshot(snapshot: &Snapshot) -> Result<(), Error> {
    ensure(
        snapshot.schema_version == 1,
        "Unsupported snapshot schemaVersion; expected 1",
    )?;
    ensure(
        snapshot.time.is_finite() && snapshot.time >= 0.0,
        "Snapshot time must be finite and nonnegative",
    )?;
    ensure(
        snapshot.time_correction.is_finite()
            && snapshot.time + snapshot.time_correction == snapshot.time,
        "Snapshot timeCorrection must be finite and normalized relative to time",
    )?;
    // Counts must remain exactly representable when round-tripped through JS.
    ensure(
        snapshot.event_count <= 9_007_199_254_740_991,
        "Snapshot eventCount exceeds JSON safe integer range",
    )?;
    let config = &snapshot.config;
    let n = config.neurons.len();
    ensure(
        snapshot.neurons.len() == n,
        "Snapshot neuron count does not match config",
    )?;
    ensure(
        snapshot.active_inputs.len() == n
            && snapshot.active_inputs.iter().all(|row| row.len() == n),
        "Snapshot activeInputs must be an N by N matrix",
    )?;
    for (current, initial) in snapshot.neurons.iter().zip(&config.neurons) {
        ensure(
            current.id == initial.id,
            "Snapshot neuron IDs/order must match config",
        )?;
        validate_potential(
            current.state,
            current.potential,
            config.parameters.threshold,
        )?;
        ensure(
            current.drive.is_finite()
                && (current.drive == 0.0 || current.drive == initial.initial_drive),
            "Snapshot drive must be zero or its original initialDrive",
        )?;
        ensure(
            current
                .next_event_in
                .is_none_or(|t| t.is_finite() && t >= 0.0),
            "Snapshot nextEventIn must be null or finite and nonnegative",
        )?;
    }
    Ok(())
}
