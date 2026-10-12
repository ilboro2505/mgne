use crate::Simulation;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = Simulation)]
pub struct WasmSimulation {
    inner: Simulation,
}

fn js_error(error: crate::Error) -> JsValue {
    JsValue::from_str(&error.to_string())
}

#[wasm_bindgen(js_class = Simulation)]
impl WasmSimulation {
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str) -> Result<WasmSimulation, JsValue> {
        Ok(Self {
            inner: Simulation::from_json(config_json).map_err(js_error)?,
        })
    }

    #[wasm_bindgen(js_name = fromSnapshot)]
    pub fn from_snapshot(snapshot_json: &str) -> Result<WasmSimulation, JsValue> {
        Ok(Self {
            inner: Simulation::from_snapshot_json(snapshot_json).map_err(js_error)?,
        })
    }

    pub fn step(&mut self, count: f64) -> Result<String, JsValue> {
        // Taking f64 avoids JS-to-u32 wrapping of negative/fractional values.
        if !count.is_finite()
            || count < 0.0
            || count.fract() != 0.0
            || count > crate::MAX_EVENTS_PER_CALL as f64
        {
            return Err(JsValue::from_str(
                "step count must be an integer in [0, 100000]",
            ));
        }
        self.inner.step_json(count as usize).map_err(js_error)
    }

    pub fn snapshot(&self) -> Result<String, JsValue> {
        self.inner.snapshot_json().map_err(js_error)
    }
}
