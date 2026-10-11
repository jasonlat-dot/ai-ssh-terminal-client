// Exercise the production process launcher in a separate binary so these OS
// lifecycle tests do not depend on unrelated SFTP unit-test fixtures.
#![allow(dead_code, unused_imports)]
#[path = "../src/backend_process.rs"]
mod backend_process;
