import { diagnoseWechatDbDirectories } from '../src/adapters/config.ts';

const diagnostics = diagnoseWechatDbDirectories();
console.log(JSON.stringify({ dbDir: diagnostics.detectedDbDir, diagnostics }));
if (!diagnostics.detectedDbDir) process.exitCode = 1;
