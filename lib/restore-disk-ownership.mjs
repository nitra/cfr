// Only exact successful VolumeRestore handles establish disk origin. A PVC-like
// name, attachment or historical backup alone is not ownership evidence.
export function restoreDiskOrigins(project, planId, volumeRestores) {
  const origins = new Map();
  for (const volume of volumeRestores) {
    if (volume.state !== 'SUCCEEDED' || volume.volumeType !== 'GCE_PERSISTENT_DISK') continue;
    const disk = volume.volumeHandle?.match(/^projects\/([^/]+)\/(?:zones|regions)\/([^/]+)\/disks\/([^/]+)$/);
    const restore = volume.name?.match(/\/locations\/([^/]+)\/restorePlans\/([^/]+)\/restores\/([^/]+)\/volumeRestores\/([^/]+)$/);
    if (!disk || disk[1] !== project || !restore || `${restore[1]}/${restore[2]}` !== planId) continue;
    if (!volume.targetPvc?.namespace || !volume.targetPvc?.name) {
      throw new Error(`Missing target PVC in ${volume.name}`);
    }
    origins.set(`${disk[2]}/${disk[3]}`, {
      kind: 'GKEBackupRestorePlan', id: planId, controller: 'gke-backup-restore',
      volumeRestore: volume.name, targetPvc: volume.targetPvc,
    });
  }
  return origins;
}

export function classifyRestoreDerived(results) {
  return results.map((resource) => {
    if (resource.status !== 'uncovered' || resource.kind !== 'ComputeDisk' || !resource.derivedFrom) return resource;
    const parent = results.find((candidate) => candidate.project === resource.project
      && candidate.kind === resource.derivedFrom.kind && candidate.id === resource.derivedFrom.id);
    if (parent?.status !== 'covered_opentofu') return resource;
    return { ...resource, status: 'controller_managed', parentState: parent.source };
  });
}
