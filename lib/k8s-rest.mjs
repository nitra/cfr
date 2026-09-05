// Тонкий REST-транспорт до Kubernetes API server — заміна шелл-аутів у
// kubectl CLI, для тих самих причин, що gcp-rest.mjs замінив gcloud: без
// залежності від встановленого на PATH kubectl.
//
// Автентифікація — той самий ADC-токен, що йде на GCP REST-виклики
// (gcp-rest.mjs:getAccessToken), не токен із самого kubeconfig. GKE
// приймає OAuth2-токен GCP IAM напряму як bearer — це буквально те, що
// робить exec-плагін `gke-gcloud-auth-plugin` під капотом kubectl, тільки
// без окремого бінарника. Тому цей шар навмисно вузький: працює для GKE
// (єдиний тип кластера, на якому реально стоїть KCC), не претендує бути
// клієнтом для будь-якого kubeconfig — client-cert- чи Azure/AWS-подібна
// exec-автентифікація тут не підтримується.
//
// server/CA беруться з kubeconfig як завжди (KUBECONFIG, чи
// ~/.kube/config; контекст — KUBE_CONTEXT, чи current-context файлу).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import https from 'node:https';
import { parse as parseYaml } from 'yaml';
import { getAccessToken } from './gcp-rest.mjs';

function kubeconfigPath() {
  return process.env.KUBECONFIG || join(homedir(), '.kube', 'config');
}

let configCache;
function loadKubeconfig() {
  if (!configCache) configCache = parseYaml(readFileSync(kubeconfigPath(), 'utf8'));
  return configCache;
}

let clusterInfoCache;
function clusterInfo() {
  if (clusterInfoCache) return clusterInfoCache;

  const config = loadKubeconfig();
  const contextName = process.env.KUBE_CONTEXT || config['current-context'];
  if (!contextName) throw new Error('kubeconfig has no current-context (set KUBE_CONTEXT)');

  const ctxEntry = (config.contexts || []).find((c) => c.name === contextName);
  if (!ctxEntry) throw new Error(`context "${contextName}" not found in kubeconfig`);

  const clusterName = ctxEntry.context.cluster;
  const clusterEntry = (config.clusters || []).find((c) => c.name === clusterName);
  if (!clusterEntry) throw new Error(`cluster "${clusterName}" not found in kubeconfig`);

  const cluster = clusterEntry.cluster;
  const ca = cluster['certificate-authority-data']
    ? Buffer.from(cluster['certificate-authority-data'], 'base64')
    : cluster['certificate-authority']
      ? readFileSync(cluster['certificate-authority'])
      : undefined;

  clusterInfoCache = { server: cluster.server, ca, insecureSkipTlsVerify: !!cluster['insecure-skip-tls-verify'] };
  return clusterInfoCache;
}

async function requestJson(pathAndQuery) {
  const { server, ca, insecureSkipTlsVerify } = clusterInfo();
  const token = await getAccessToken();
  const url = new URL(pathAndQuery, server);

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      ca,
      rejectUnauthorized: !insecureSkipTlsVerify,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`kubernetes API ${res.statusCode} ${pathAndQuery}: ${body.slice(0, 300)}`);
          err.status = res.statusCode;
          reject(err);
          return;
        }
        try {
          resolve(body ? JSON.parse(body) : null);
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Один namespace, або null якщо його немає (404) — той самий сигнал, що
 * раніше давав ненульовий exit-код kubectl.
 */
export async function getNamespace(name) {
  try {
    return await requestJson(`/api/v1/namespaces/${encodeURIComponent(name)}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Усі namespace кластера.
 */
export async function listNamespaces() {
  const data = await requestJson('/api/v1/namespaces');
  return (data && data.items) || [];
}

// group + множина для кожного виду KCC-ресурсу, який сканує
// get-resources.mjs. Версія скрізь v1beta1 — стандарт KCC, не наш вибір.
export const CRD_GVR = {
  IAMServiceAccount: { group: 'iam.cnrm.cloud.google.com', plural: 'iamserviceaccounts' },
  IAMServiceAccountKey: { group: 'iam.cnrm.cloud.google.com', plural: 'iamserviceaccountkeys' },
  IAMWorkloadIdentityPool: { group: 'iam.cnrm.cloud.google.com', plural: 'iamworkloadidentitypools' },
  IAMWorkloadIdentityPoolProvider: { group: 'iam.cnrm.cloud.google.com', plural: 'iamworkloadidentitypoolproviders' },
  ArtifactRegistryRepository: { group: 'artifactregistry.cnrm.cloud.google.com', plural: 'artifactregistryrepositories' },
  ContainerCluster: { group: 'container.cnrm.cloud.google.com', plural: 'containerclusters' },
  ContainerNodePool: { group: 'container.cnrm.cloud.google.com', plural: 'containernodepools' },
  StorageBucket: { group: 'storage.cnrm.cloud.google.com', plural: 'storagebuckets' },
  ComputeAddress: { group: 'compute.cnrm.cloud.google.com', plural: 'computeaddresses' },
  DNSManagedZone: { group: 'dns.cnrm.cloud.google.com', plural: 'dnsmanagedzones' },
  DNSRecordSet: { group: 'dns.cnrm.cloud.google.com', plural: 'dnsrecordsets' },
  RunService: { group: 'run.cnrm.cloud.google.com', plural: 'runservices' },
  RunJob: { group: 'run.cnrm.cloud.google.com', plural: 'runjobs' },
  CloudSchedulerJob: { group: 'cloudscheduler.cnrm.cloud.google.com', plural: 'cloudschedulerjobs' },
  EventarcTrigger: { group: 'eventarc.cnrm.cloud.google.com', plural: 'eventarctriggers' },
  PubSubTopic: { group: 'pubsub.cnrm.cloud.google.com', plural: 'pubsubtopics' },
  PubSubSubscription: { group: 'pubsub.cnrm.cloud.google.com', plural: 'pubsubsubscriptions' },
  SecretManagerSecret: { group: 'secretmanager.cnrm.cloud.google.com', plural: 'secretmanagersecrets' },
  VPCAccessConnector: { group: 'vpcaccess.cnrm.cloud.google.com', plural: 'vpcaccessconnectors' },
  ComputeNetwork: { group: 'compute.cnrm.cloud.google.com', plural: 'computenetworks' },
  ComputeSubnetwork: { group: 'compute.cnrm.cloud.google.com', plural: 'computesubnetworks' },
  KMSCryptoKey: { group: 'kms.cnrm.cloud.google.com', plural: 'kmscryptokeys' },
  ComputeBackendService: { group: 'compute.cnrm.cloud.google.com', plural: 'computebackendservices' },
  ComputeNetworkEndpointGroup: { group: 'compute.cnrm.cloud.google.com', plural: 'computenetworkendpointgroups' },
  ComputeURLMap: { group: 'compute.cnrm.cloud.google.com', plural: 'computeurlmaps' },
  ComputeTargetHTTPSProxy: { group: 'compute.cnrm.cloud.google.com', plural: 'computetargethttpsproxies' },
  ComputeGlobalForwardingRule: { group: 'compute.cnrm.cloud.google.com', plural: 'computeglobalforwardingrules' },
  ComputeSSLCertificate: { group: 'compute.cnrm.cloud.google.com', plural: 'computesslcertificates' },
  ComputeManagedSSLCertificate: { group: 'compute.cnrm.cloud.google.com', plural: 'computemanagedsslcertificates' },
  IAMPolicyMember: { group: 'iam.cnrm.cloud.google.com', plural: 'iampolicymembers' },
};

/**
 * Усі CR даного KCC-виду в namespace. Порожній масив, якщо CRD не
 * встановлений (404) — той самий сигнал, що раніше давав ненульовий
 * exit-код kubectl, коли CRD немає в кластері. Інші помилки (401/403/
 * мережа) кидаються далі.
 */
export async function listCustomObjects(kind, namespace) {
  const { group, plural } = CRD_GVR[kind];
  try {
    const data = await requestJson(`/apis/${group}/v1beta1/namespaces/${encodeURIComponent(namespace)}/${plural}`);
    return (data && data.items) || [];
  } catch (err) {
    if (err.status === 404) return [];
    throw err;
  }
}
