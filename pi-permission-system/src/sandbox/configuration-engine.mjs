const args = process.argv.slice(2);
const allowedFilterNames = new Set(["devcontainer.local_folder", "devcontainer.config_file"]);
let validDiscovery = args[0] === "ps";
let quiet = false;
let all = false;
for (let index = 1; validDiscovery && index < args.length; index++) {
  const argument = args[index];
  if (argument === "-q") {
    quiet = true;
  } else if (argument === "-a") {
    all = true;
  } else if (argument === "--filter") {
    const filter = args[++index];
    const label = filter?.startsWith("label=") ? filter.slice("label=".length) : undefined;
    const separator = label?.indexOf("=") ?? -1;
    validDiscovery = separator > 0 && allowedFilterNames.has(label.slice(0, separator));
  } else {
    validDiscovery = false;
  }
}
if (!validDiscovery || !quiet || !all) {
  process.stderr.write("Configuration-only discovery cannot execute engine operations\n");
  process.exitCode = 1;
}
