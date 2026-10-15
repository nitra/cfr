// Cloud Asset searchAllIamPolicies is eventually consistent and can lag behind
// the real policy, which produced false `orphan_opentofu` IAM members. Before
// reporting such an orphan, read the owner's policy directly (read-only
// getIamPolicy) - once per target, with a call cap. A binding that is really
// there turns the orphan into covered_opentofu (verified_via=getIamPolicy).
import { getJson, postJson } from './gcp-rest.mjs';
import { iamConditionKey } from './controller-inventory.mjs';

export const MAX_VERIFY_CALLS = 25;

// Returns {kind, call} for a declaration's iamTarget, or null if unsupported.
export function policyRequest(target) {
  let m;
  if ((m = target.match(/^project\/([^/]+)$/))) {
    return { key: target, call: () => postJson(`https://cloudresourcemanager.googleapis.com/v1/projects/${m[1]}:getIamPolicy`, { options: { requestedPolicyVersion: 3 } }) };
  }
  if ((m = target.match(/^sa\/(.+)$/))) {
    return { key: target, call: () => postJson(`https://iam.googleapis.com/v1/projects/-/serviceAccounts/${m[1]}:getIamPolicy`, { options: { requestedPolicyVersion: 3 } }) };
  }
  if ((m = target.match(/^bucket\/(.+)$/))) {
    return { key: target, call: () => getJson(`https://storage.googleapis.com/storage/v1/b/${m[1]}/iam`, { optionsRequestedPolicyVersion: 3 }) };
  }
  if ((m = target.match(/^other\/secretmanager\.googleapis\.com\/projects\/([^/]+)\/secrets\/([^/]+)$/))) {
    return { key: target, call: () => getJson(`https://secretmanager.googleapis.com/v1/projects/${m[1]}/secrets/${m[2]}:getIamPolicy`, { 'options.requestedPolicyVersion': 3 }) };
  }
  return null;
}

const CASE_INSENSITIVE_MEMBER = /^(?:serviceAccount|user|group|domain):/;
function sameMember(a, b) {
  return a === b || (CASE_INSENSITIVE_MEMBER.test(a) && a.toLowerCase() === b.toLowerCase());
}

export function policyHasBinding(policy, { role, member, condition }) {
  const wanted = iamConditionKey(condition);
  return (policy?.bindings || []).some((binding) => binding.role === role
    && iamConditionKey(binding.condition) === wanted
    && (binding.members || []).some((m) => sameMember(m, member)));
}

/**
 * @returns {Promise<{results: object[], warnings: string[]}>}
 */
export async function verifyIamOrphans(results, { fetchPolicy, maxCalls = MAX_VERIFY_CALLS } = {}) {
  const warnings = [];
  const cache = new Map();
  let calls = 0;
  const out = [];
  for (const result of results) {
    if (result.status !== 'orphan_opentofu' || result.kind !== 'IAMPolicyMember' || !result.iamTarget || !result.role || !result.member) {
      out.push(result);
      continue;
    }
    const request = policyRequest(result.iamTarget);
    if (!request) {
      out.push(result);
      continue;
    }
    if (!cache.has(request.key)) {
      if (calls >= maxCalls) {
        cache.set(request.key, { skipped: true });
      } else {
        calls += 1;
        try {
          cache.set(request.key, { policy: await (fetchPolicy ? fetchPolicy(result.iamTarget) : request.call()) });
        } catch (err) {
          const code = err?.response?.status || err?.code || '';
          cache.set(request.key, { error: `${code} ${err?.message || err}`.trim() });
        }
      }
    }
    const entry = cache.get(request.key);
    if (entry.policy) {
      out.push(policyHasBinding(entry.policy, result)
        ? { ...result, status: 'covered_opentofu', verified_via: 'getIamPolicy' } : result);
    } else if (entry.skipped) {
      out.push({ ...result, verification: `skipped: more than ${maxCalls} policy reads needed` });
    } else {
      out.push({ ...result, verification: `failed: ${entry.error}` });
    }
  }
  const failed = new Set(out.filter((r) => r.verification?.startsWith('failed')).map((r) => r.iamTarget));
  for (const target of failed) {
    warnings.push(`cannot verify orphan IAM bindings on ${target} via getIamPolicy (permission or API error); left as orphan_opentofu`);
  }
  if (out.some((r) => r.verification?.startsWith('skipped'))) {
    warnings.push(`orphan IAM verification capped at ${maxCalls} policy reads; remaining orphans were not verified`);
  }
  return { results: out, warnings };
}
