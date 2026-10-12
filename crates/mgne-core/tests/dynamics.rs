use mgne_core::*;
use std::collections::BTreeSet;

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() <= 2e-12 * expected.abs().max(1.0),
        "actual={actual:.17}, expected={expected:.17}"
    );
}

fn neuron(id: &str, potential: f64, state: NeuronState, drive: f64) -> NeuronConfig {
    NeuronConfig {
        id: id.into(),
        potential,
        state,
        initial_drive: drive,
    }
}

fn config(
    parameters: Parameters,
    neurons: Vec<NeuronConfig>,
    connections: Vec<Connection>,
) -> Config {
    let model = if neurons.iter().any(|n| n.initial_drive != 0.0) {
        Model::MoneInitialDriveV1
    } else {
        Model::MoneV1
    };
    Config {
        schema_version: 1,
        model,
        parameters,
        neurons,
        connections,
    }
}

fn oscillator() -> Config {
    config(
        Parameters {
            threshold: 17.0,
            rest: 20.0,
            alpha: 0.5,
            refractory_period: 3.0,
        },
        vec![neuron("a", 0.0, NeuronState::Receptive, 0.0)],
        vec![],
    )
}

fn detector_parameters() -> Parameters {
    Parameters {
        threshold: 2.0,
        rest: 1.0,
        alpha: 1.0,
        refractory_period: 1.0,
    }
}

fn edge(source: &str, target: &str, weight: f64) -> Connection {
    Connection {
        source: source.into(),
        target: target.into(),
        weight,
    }
}

fn ring() -> Config {
    let potentials = [15.0, 13.0, 11.0, 9.0, 7.0, 5.0];
    let weights = [1.286, 0.413, 0.223, 0.014, 0.585, 0.832];
    let mut cfg = oscillator();
    cfg.neurons = potentials
        .iter()
        .enumerate()
        .map(|(i, &u)| neuron(&(i + 1).to_string(), u, NeuronState::Receptive, 0.0))
        .collect();
    cfg.connections = weights
        .iter()
        .enumerate()
        .map(|(i, &w)| edge(&(i + 1).to_string(), &((i + 1) % 6 + 1).to_string(), w))
        .collect();
    cfg
}

#[test]
fn isolated_oscillator_matches_analytical_period_and_refractory_recovery() {
    let mut sim = Simulation::new(oscillator()).unwrap();
    let result = sim.step(5).unwrap();
    let charge = (20_f64 / 3.0).ln() / 0.5;
    assert_eq!(result.events.len(), 5);
    close(result.events[0].time, charge);
    close(result.events[1].time, charge + 3.0);
    close(result.events[2].time - result.events[0].time, charge + 3.0);
    close(result.events[4].time - result.events[2].time, charge + 3.0);
    assert_eq!(result.events[0].spikes, ["a"]);
    assert_eq!(result.events[1].recovered, ["a"]);
    assert_eq!(result.snapshot.neurons[0].potential, -1.0);
}

#[test]
fn detector_and_threshold_equilibrium_halt_without_inventing_events() {
    for rest in [1.0, 2.0] {
        let mut parameters = detector_parameters();
        parameters.rest = rest;
        let cfg = config(
            parameters,
            vec![neuron("a", 0.0, NeuronState::Receptive, 0.0)],
            vec![],
        );
        let mut sim = Simulation::new(cfg).unwrap();
        let before = sim.snapshot().unwrap();
        let run = sim.step(1000).unwrap();
        assert!(run.halted);
        assert!(run.events.is_empty());
        assert_eq!(run.snapshot, before);
        assert_eq!(sim.step(1000).unwrap().snapshot, before);
    }
}

#[test]
fn initial_drive_trajectory_is_independent_of_an_unrelated_event() {
    let cfg = config(
        detector_parameters(),
        vec![
            neuron("stimulated", 0.0, NeuronState::Receptive, 2.0),
            neuron("unrelated", -0.5, NeuronState::Refractory, 0.0),
        ],
        vec![],
    );
    let mut sim = Simulation::new(cfg).unwrap();
    let first = sim.step(1).unwrap();
    close(first.events[0].time, 0.5);
    close(
        first.snapshot.neurons[0].potential,
        3.0 * (1.0 - (-0.5_f64).exp()),
    );
    close(
        first.snapshot.neurons[0].next_event_in.unwrap() + first.snapshot.time,
        3_f64.ln(),
    );
    let second = sim.step(1).unwrap();
    close(second.events[0].time, 3_f64.ln());
    assert_eq!(second.events[0].spikes, ["stimulated"]);
    assert_eq!(second.snapshot.neurons[0].drive, 0.0);
}

#[test]
fn simultaneous_recovery_clears_old_inputs_then_receives_new_spikes() {
    let mut parameters = detector_parameters();
    parameters.refractory_period = 2.0 * 3_f64.ln();
    let cfg = config(
        parameters,
        vec![
            neuron("source", 0.0, NeuronState::Receptive, 2.0),
            neuron("target", -0.5, NeuronState::Refractory, 0.0),
            neuron("old", 0.0, NeuronState::Receptive, 0.0),
        ],
        vec![edge("source", "target", 2.0), edge("old", "target", 0.25)],
    );
    let mut snapshot = Simulation::new(cfg).unwrap().snapshot().unwrap();
    snapshot.active_inputs[2][1] = true;
    let mut sim = Simulation::from_snapshot(snapshot).unwrap();
    let run = sim.step(1).unwrap();
    assert_eq!(run.events[0].spikes, ["source"]);
    assert_eq!(run.events[0].recovered, ["target"]);
    assert!(run.snapshot.active_inputs[0][1]);
    assert!(!run.snapshot.active_inputs[2][1]);
    assert_eq!(run.snapshot.neurons[1].potential, 0.0);
    close(run.snapshot.neurons[1].next_event_in.unwrap(), 3_f64.ln());
}

#[test]
fn subthreshold_input_is_retained_after_the_network_becomes_quiet() {
    let mut parameters = detector_parameters();
    parameters.threshold = 3.0;
    let cfg = config(
        parameters,
        vec![
            neuron("source", 0.0, NeuronState::Receptive, 3.0),
            neuron("target", 0.0, NeuronState::Receptive, 0.0),
        ],
        vec![edge("source", "target", 1.0)],
    );
    let mut sim = Simulation::new(cfg).unwrap();
    let run = sim.step(100).unwrap();
    assert_eq!(run.events.len(), 2);
    assert!(run.halted);
    assert!(run.snapshot.active_inputs[0][1]);
    assert!(run.snapshot.neurons[1].potential < 2.0);
    assert_eq!(run.snapshot.neurons[1].next_event_in, None);
}

#[test]
fn repeated_spikes_do_not_accumulate_a_binary_synaptic_input() {
    let parameters = Parameters {
        threshold: 20.0,
        rest: 17.0,
        alpha: 0.5,
        refractory_period: 0.1,
    };
    let cfg = config(
        parameters,
        vec![
            neuron("a", 0.0, NeuronState::Receptive, 5.0),
            neuron("b", 0.0, NeuronState::Receptive, 0.0),
            neuron("readout", 0.0, NeuronState::Receptive, 0.0),
        ],
        vec![
            edge("a", "b", 5.0),
            edge("b", "a", 5.0),
            edge("a", "readout", 1.0),
        ],
    );
    let mut sim = Simulation::new(cfg).unwrap();
    let result = sim.step(100).unwrap();
    assert!(
        result
            .events
            .iter()
            .filter(|e| e.spikes.contains(&"a".into()))
            .count()
            > 10
    );
    assert!(result
        .events
        .iter()
        .all(|e| !e.spikes.contains(&"readout".into())));
    assert!(result.snapshot.active_inputs[0][2]);
    assert!(result.snapshot.neurons[2].potential <= 18.0);
    assert_eq!(result.snapshot.neurons[2].next_event_in, None);
}

#[test]
fn initial_drive_survives_initial_refractory_state_until_first_spike() {
    let cfg = config(
        detector_parameters(),
        vec![neuron("a", -0.5, NeuronState::Refractory, 2.0)],
        vec![],
    );
    let mut sim = Simulation::new(cfg).unwrap();
    let recovery = sim.step(1).unwrap();
    assert_eq!(recovery.snapshot.neurons[0].drive, 2.0);
    let spike = sim.step(1).unwrap();
    close(spike.snapshot.time, 0.5 + 3_f64.ln());
    assert_eq!(spike.snapshot.neurons[0].drive, 0.0);
    assert!(sim.step(10).unwrap().halted);
}

#[test]
fn batch_chunking_and_json_restore_preserve_complete_state() {
    let mut batch = Simulation::new(ring()).unwrap();
    let expected = batch.step(300).unwrap();
    let mut chunked = Simulation::new(ring()).unwrap();
    let first = chunked.step(137).unwrap();
    let mut restored =
        Simulation::from_snapshot_json(&serde_json::to_string(&first.snapshot).unwrap()).unwrap();
    let final_chunk = restored.step(163).unwrap();
    let mut combined = first.events;
    combined.extend(final_chunk.events);
    assert_eq!(expected.events, combined);
    assert_eq!(expected.snapshot, final_chunk.snapshot);
    for _ in 137..300 {
        chunked.step(1).unwrap();
    }
    assert_eq!(expected.snapshot, chunked.snapshot().unwrap());
}

#[test]
fn neuron_order_does_not_change_dynamics() {
    let first_config = ring();
    let mut reversed_config = first_config.clone();
    reversed_config.neurons.reverse();
    reversed_config.connections.reverse();
    let first = Simulation::new(first_config).unwrap().step(300).unwrap();
    let second = Simulation::new(reversed_config).unwrap().step(300).unwrap();
    assert_eq!(first.events.len(), second.events.len());
    for (a, b) in first.events.iter().zip(&second.events) {
        assert_eq!(a.time, b.time);
        assert_eq!(
            a.spikes.iter().collect::<BTreeSet<_>>(),
            b.spikes.iter().collect::<BTreeSet<_>>()
        );
        assert_eq!(
            a.recovered.iter().collect::<BTreeSet<_>>(),
            b.recovered.iter().collect::<BTreeSet<_>>()
        );
    }
    for a in &first.snapshot.neurons {
        assert_eq!(
            a,
            second
                .snapshot
                .neurons
                .iter()
                .find(|b| b.id == a.id)
                .unwrap()
        );
    }
}

#[test]
fn grouping_uses_local_relative_precision_without_a_fixed_time_window() {
    let mut cfg = oscillator();
    cfg.parameters.refractory_period = 1e-6;
    cfg.neurons = vec![
        neuron("a", -0.5, NeuronState::Refractory, 0.0),
        neuron("b", -0.5 - 1e-15, NeuronState::Refractory, 0.0),
        neuron("c", -0.5 - 1e-10, NeuronState::Refractory, 0.0),
    ];
    let result = Simulation::new(cfg).unwrap().step(1).unwrap();
    assert_eq!(result.events[0].recovered, ["a", "b"]);
    assert_eq!(result.snapshot.neurons[2].state, NeuronState::Refractory);
}

#[test]
fn an_asymptotic_trajectory_cannot_round_into_a_spike() {
    let mut parameters = detector_parameters();
    parameters.threshold = 1.0;
    parameters.refractory_period = 1e6;
    let cfg = config(
        parameters,
        vec![
            neuron("timer", -1.0, NeuronState::Refractory, 0.0),
            neuron("asymptote", 0.0, NeuronState::Receptive, 0.0),
        ],
        vec![],
    );
    let result = Simulation::new(cfg).unwrap().step(1).unwrap();
    assert!(result.halted);
    assert!(result.events[0].spikes.is_empty());
    assert!(result.snapshot.neurons[1].potential < 1.0);
}

#[test]
fn invalid_domains_and_ambiguous_topology_are_rejected() {
    let mut invalids = Vec::new();
    let mut cfg = oscillator();
    cfg.parameters.alpha = 0.0;
    invalids.push(cfg);
    let mut cfg = oscillator();
    cfg.parameters.threshold = f64::NAN;
    invalids.push(cfg);
    let mut cfg = oscillator();
    cfg.neurons[0].potential = 17.0;
    invalids.push(cfg);
    let mut cfg = oscillator();
    cfg.neurons[0].potential = -0.1;
    invalids.push(cfg);
    let mut cfg = oscillator();
    cfg.neurons[0].initial_drive = 1.0;
    invalids.push(cfg);
    let mut cfg = oscillator();
    cfg.neurons.push(cfg.neurons[0].clone());
    invalids.push(cfg);
    let mut cfg = ring();
    cfg.connections[0].weight = -1.0;
    invalids.push(cfg);
    let mut cfg = ring();
    cfg.connections[0].target = cfg.connections[0].source.clone();
    invalids.push(cfg);
    let mut cfg = ring();
    cfg.connections.push(cfg.connections[0].clone());
    invalids.push(cfg);
    let mut cfg = ring();
    cfg.connections[0].target = "missing".into();
    invalids.push(cfg);
    let mut cfg = oscillator();
    cfg.neurons.clear();
    invalids.push(cfg);
    for (index, cfg) in invalids.into_iter().enumerate() {
        assert!(
            Simulation::new(cfg).is_err(),
            "Invalid fixture {index} accepted"
        );
    }
}

#[test]
fn malformed_snapshots_fail_and_next_event_hints_cannot_change_dynamics() {
    let mut original = Simulation::new(ring()).unwrap();
    original.step(13).unwrap();
    let valid = original.snapshot().unwrap();
    let mut invalid = valid.clone();
    invalid.active_inputs.pop();
    assert!(Simulation::from_snapshot(invalid).is_err());
    let mut invalid = valid.clone();
    invalid.neurons[0].drive = 1.0;
    assert!(Simulation::from_snapshot(invalid).is_err());
    let mut invalid = valid.clone();
    invalid.neurons[0].id = "wrong".into();
    assert!(Simulation::from_snapshot(invalid).is_err());
    let mut invalid = valid.clone();
    invalid.time = -1.0;
    assert!(Simulation::from_snapshot(invalid).is_err());
    let mut altered_hint = valid;
    altered_hint.neurons[0].next_event_in = Some(1234.0);
    let restored = Simulation::from_snapshot(altered_hint).unwrap();
    assert_eq!(original.snapshot().unwrap(), restored.snapshot().unwrap());
}

#[test]
fn unsupported_precision_and_oversized_batches_error_without_mutation() {
    let mut snapshot = Simulation::new(oscillator()).unwrap().snapshot().unwrap();
    snapshot.time = 1e300;
    snapshot.time_correction = 1e280;
    let mut sim = Simulation::from_snapshot(snapshot.clone()).unwrap();
    assert!(sim.step(1).is_err());
    assert_eq!(sim.snapshot().unwrap(), snapshot);
    let mut sim = Simulation::new(oscillator()).unwrap();
    let before = sim.snapshot().unwrap();
    assert!(sim.step(MAX_EVENTS_PER_CALL + 1).is_err());
    assert_eq!(sim.snapshot().unwrap(), before);
    assert_eq!(sim.step(0).unwrap().snapshot, before);

    let mut sim = Simulation::new(ring()).unwrap();
    let before = sim.snapshot().unwrap();
    // Six nodes cannot exceed this limit with 100k groups, so exercise a larger
    // legal network whose requested output would otherwise be excessive.
    let mut large = oscillator();
    large.neurons = (0..MAX_NEURONS)
        .map(|i| neuron(&i.to_string(), 0.0, NeuronState::Receptive, 0.0))
        .collect();
    let mut large = Simulation::new(large).unwrap();
    let large_before = large.snapshot().unwrap();
    assert!(large
        .step(MAX_NEURON_EVENTS_PER_CALL / MAX_NEURONS + 1)
        .is_err());
    assert_eq!(large.snapshot().unwrap(), large_before);
    assert_eq!(sim.step(0).unwrap().snapshot, before);
}

#[test]
fn a_counter_error_rolls_back_the_entire_batch() {
    let mut snapshot = Simulation::new(oscillator()).unwrap().snapshot().unwrap();
    // The first group reaches the JSON-safe limit; the second must fail and
    // roll back all state, including the compensated clock and input matrix.
    snapshot.event_count = 9_007_199_254_740_990;
    let mut sim = Simulation::from_snapshot(snapshot.clone()).unwrap();
    assert!(sim.step(2).is_err());
    assert_eq!(sim.snapshot().unwrap(), snapshot);
}

#[test]
fn causal_spikes_may_share_a_timestamp_without_losing_local_elapsed_time() {
    let parameters = Parameters {
        threshold: 2.0,
        rest: 2.01,
        alpha: 1.0,
        refractory_period: 1.0,
    };
    let cfg = config(
        parameters,
        vec![
            neuron("source", 1.99, NeuronState::Receptive, 0.0),
            neuron("target", 1.989999999999998, NeuronState::Receptive, 0.0),
        ],
        vec![edge("source", "target", 20.0)],
    );
    let mut sim = Simulation::new(cfg).unwrap();
    let first = sim.step(1).unwrap();
    assert_eq!(first.events[0].spikes, ["source"]);
    let second = sim.step(1).unwrap();
    assert_eq!(second.events[0].spikes, ["target"]);
    assert_eq!(first.events[0].time, second.events[0].time);
    assert!(second.events[0].delta > 0.0);
    assert_eq!(
        second.snapshot.time_correction - first.snapshot.time_correction,
        second.events[0].delta
    );
    let restored = Simulation::from_snapshot_json(&sim.snapshot_json().unwrap()).unwrap();
    assert_eq!(restored.snapshot().unwrap(), sim.snapshot().unwrap());
}

#[test]
fn compensated_clock_accumulates_sub_ulp_intervals_without_changing_event_groups() {
    let mut baseline = Simulation::new(oscillator()).unwrap();
    let mut shifted = baseline.snapshot().unwrap();
    shifted.time = 2_f64.powi(54);
    let mut shifted = Simulation::from_snapshot(shifted).unwrap();
    let expected = baseline.step(100).unwrap();
    let actual = shifted.step(100).unwrap();
    assert_eq!(expected.events.len(), actual.events.len());
    for (a, b) in expected.events.iter().zip(&actual.events) {
        assert_eq!(a.delta, b.delta);
        assert_eq!(a.spikes, b.spikes);
        assert_eq!(a.recovered, b.recovered);
    }
    close(
        actual.snapshot.time - 2_f64.powi(54) + actual.snapshot.time_correction,
        expected.snapshot.time + expected.snapshot.time_correction,
    );
    assert!(actual
        .events
        .windows(2)
        .all(|pair| pair[1].time >= pair[0].time));
}

#[test]
fn thesis_ring_remains_computable_as_phases_converge() {
    let mut sim = Simulation::new(ring()).unwrap();
    for index in 0..12_000 {
        if let Err(error) = sim.step(1) {
            panic!("group {index}: {error}; {:?}", sim.snapshot());
        }
    }
}
