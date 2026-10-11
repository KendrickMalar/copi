// Loaded before every test file (see the npm "test" script). Child processes inherit process.env, and a real
// `pi` on the developer's PATH would otherwise add the opt-in "Ask Pi" prompt to every setup run. Tests that
// exercise suggestions point COPI_PI_COMMAND at a fake Pi explicitly.
process.env.COPI_PI_COMMAND = "/nonexistent/copi-test-no-pi";
