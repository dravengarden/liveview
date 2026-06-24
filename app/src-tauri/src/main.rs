// Desktop entry point. `windows_subsystem = "windows"` in release hides the
// console window on Windows; harmless elsewhere. Mobile never reaches here — it
// enters through `liveview_app_lib::run`'s `mobile_entry_point`.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    liveview_app_lib::run()
}
