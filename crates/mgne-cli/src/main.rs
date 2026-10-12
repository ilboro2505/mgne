use mgne_core::{Simulation, MAX_EVENTS_PER_CALL};
use std::collections::HashMap;
use std::error::Error;
use std::fs;
use std::io::{self, Write};
use std::path::Path;

const HELP: &str = "MGNE event-driven simulator

Usage:
  mgne run --config FILE --events N [--output FILE] [--snapshot-out FILE]
  mgne resume --snapshot FILE --events N [--output FILE] [--snapshot-out FILE]

The output is a RunResult JSON document (stdout unless --output is supplied).
--snapshot-out additionally saves only the final snapshot for later resume.
N counts event groups, including refractory recoveries; allowed range: 0..100000.
N times the neuron count must be <= 2000000; use smaller batches for larger networks.
A quiet network stops early. Config and snapshot schemaVersion must be 1.
";

fn main() {
    if let Err(error) = execute(std::env::args().skip(1).collect()) {
        eprintln!("mgne: {error}");
        std::process::exit(1);
    }
}

fn execute(args: Vec<String>) -> Result<(), Box<dyn Error>> {
    if args.is_empty() || args == ["--help"] || args == ["-h"] {
        print!("{HELP}");
        return Ok(());
    }
    if args == ["--version"] {
        println!("mgne {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let command = &args[0];
    let input_flag = match command.as_str() {
        "run" => "--config",
        "resume" => "--snapshot",
        _ => return Err(format!("Unknown command {command}; use --help").into()),
    };
    let options = parse_options(&args[1..], input_flag)?;
    let input = required(&options, input_flag)?;
    let count = required(&options, "--events")?
        .parse::<usize>()
        .map_err(|_| "--events must be a nonnegative integer")?;
    if count > MAX_EVENTS_PER_CALL {
        return Err(format!("--events must be <= {MAX_EVENTS_PER_CALL}").into());
    }
    validate_output_paths(&options, input)?;
    let metadata = fs::metadata(input).map_err(|error| format!("Cannot read {input}: {error}"))?;
    if metadata.len() > 32 * 1024 * 1024 {
        return Err("Input file exceeds 32 MiB".into());
    }
    let json = fs::read_to_string(input)?;
    let mut simulation = if command == "run" {
        Simulation::from_json(&json)?
    } else {
        Simulation::from_snapshot_json(&json)?
    };
    let result = simulation.step(count)?;
    let output = serde_json::to_string_pretty(&result)? + "\n";
    if let Some(path) = options.get("--output") {
        fs::write(path, output)?;
    } else {
        io::stdout().lock().write_all(output.as_bytes())?;
    }
    if let Some(path) = options.get("--snapshot-out") {
        fs::write(path, serde_json::to_string_pretty(&result.snapshot)? + "\n")?;
    }
    Ok(())
}

fn parse_options(
    args: &[String],
    input_flag: &str,
) -> Result<HashMap<String, String>, Box<dyn Error>> {
    let mut options = HashMap::new();
    let (pairs, remainder) = args.as_chunks::<2>();
    if !remainder.is_empty() {
        return Err("Every option requires a value; use --help".into());
    }
    for pair in pairs {
        let flag = &pair[0];
        if ![input_flag, "--events", "--output", "--snapshot-out"].contains(&flag.as_str()) {
            return Err(format!("Unknown option {flag}; use --help").into());
        }
        if options.insert(flag.clone(), pair[1].clone()).is_some() {
            return Err(format!("Duplicate option {flag}").into());
        }
    }
    Ok(options)
}

fn required<'a>(
    options: &'a HashMap<String, String>,
    name: &str,
) -> Result<&'a str, Box<dyn Error>> {
    options
        .get(name)
        .map(String::as_str)
        .ok_or_else(|| format!("Missing {name}; use --help").into())
}

fn resolved(path: &str) -> Result<std::path::PathBuf, Box<dyn Error>> {
    let path = Path::new(path);
    if path.exists() {
        return Ok(path.canonicalize()?);
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    Ok(parent
        .canonicalize()?
        .join(path.file_name().ok_or("Invalid output path")?))
}

fn validate_output_paths(
    options: &HashMap<String, String>,
    input: &str,
) -> Result<(), Box<dyn Error>> {
    let mut paths = vec![resolved(input)?];
    for flag in ["--output", "--snapshot-out"] {
        if let Some(path) = options.get(flag) {
            let path = resolved(path)?;
            if paths.contains(&path) {
                return Err("Input, output, and snapshot output must be different files".into());
            }
            paths.push(path);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ambiguous_or_incomplete_arguments() {
        assert!(execute(vec!["run".into()]).is_err());
        assert!(execute(vec!["run".into(), "--events".into()]).is_err());
        assert!(parse_options(
            &["--events".into(), "2".into(), "--events".into(), "3".into()],
            "--config"
        )
        .is_err());
        assert!(parse_options(&["--snapshot".into(), "x".into()], "--config").is_err());
    }
}
