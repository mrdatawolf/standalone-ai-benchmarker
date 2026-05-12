import si from 'systeminformation';
import { hostname } from 'node:os';

export async function getHardwareInfo() {
  const [cpu, graphics, mem, osInfo] = await Promise.all([
    si.cpu(),
    si.graphics(),
    si.mem(),
    si.osInfo(),
  ]);

  const gpu = graphics.controllers?.[0];

  return {
    hostname: hostname(),
    os: `${osInfo.platform} ${osInfo.release}`.trim(),
    arch: osInfo.arch,
    cpu: `${cpu.manufacturer} ${cpu.brand}`.trim(),
    cpuCores: cpu.physicalCores,
    ramGb: Math.round(mem.total / 1024 / 1024 / 1024),
    gpu: gpu?.model ?? 'None',
    gpuVramGb: gpu?.vram ? Math.round(gpu.vram / 1024) : null,
  };
}
