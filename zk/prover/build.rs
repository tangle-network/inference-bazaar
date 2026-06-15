//! Compiles the guest ELF on host build. Set SP1_SKIP_PROGRAM_BUILD=1 to skip
//! (CI without the succinct toolchain); `include_elf!` then has no ELF and the
//! prover bins must not be run — building them still succeeds via the stub.
fn main() {
    println!("cargo:rerun-if-env-changed=SP1_SKIP_PROGRAM_BUILD");
    if std::env::var("SP1_SKIP_PROGRAM_BUILD").is_ok() {
        let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("stub.elf");
        std::fs::write(&out, []).unwrap();
        println!("cargo:rustc-env=SP1_ELF_inference-bazaar-batch-program={}", out.display());
        return;
    }
    sp1_helper::build_program_with_args("../program", Default::default());
}
