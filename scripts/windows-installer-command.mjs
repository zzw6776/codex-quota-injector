export function windowsInstallerArguments({
  version,
  inputExecutable,
  windowsRelayExecutable,
  wslRelayExecutable,
  appIcon,
  nodeLicense,
  outputExecutable,
  scriptPath,
}) {
  return [
    "/INPUTCHARSET",
    "UTF8",
    `/DVERSION=${version}`,
    `/DINPUT_EXE=${inputExecutable}`,
    `/DWINDOWS_RELAY_EXE=${windowsRelayExecutable}`,
    `/DWSL_RELAY_EXE=${wslRelayExecutable}`,
    `/DAPP_ICON=${appIcon}`,
    `/DNODE_LICENSE=${nodeLicense}`,
    `/DOUTPUT_EXE=${outputExecutable}`,
    scriptPath,
  ];
}
