// Тонкий REST-транспорт до Google Cloud API — заміна шелл-аутів у gcloud
// CLI. Автентифікація через Application Default Credentials (той самий
// механізм, що й gcloud: `gcloud auth application-default login` локально,
// service account key через GOOGLE_APPLICATION_CREDENTIALS, метадата-сервер
// на GCE/GKE) — жодного окремого налаштування не додає, лише прибирає
// залежність від встановленого `gcloud` на PATH і повільний старт
// Python-процесу на кожен виклик.
import { GoogleAuth } from 'google-auth-library';

let authClientPromise;
function client() {
  if (!authClientPromise) {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    authClientPromise = auth.getClient();
  }
  return authClientPromise;
}

/**
 * Свіжий access token з того самого ADC-клієнта, що й GCP REST-виклики —
 * спільний з k8s-rest.mjs: GKE приймає токен GCP IAM напряму як bearer
 * (те саме, що робить `gke-gcloud-auth-plugin` під капотом kubectl), тож
 * окремого клієнта чи окремого запиту токена для k8s-боку не треба.
 */
export async function getAccessToken() {
  const c = await client();
  const { token } = await c.getAccessToken();
  return token;
}

/**
 * GET-запит, повертає розпарсений JSON. Помилку не ковтає мовчки — на
 * відміну від gcloud-версії (де collectNamespace просто бачив би порожній
 * результат), кидає далі, щоб причина (401/403/мережа) була видна.
 */
export async function getJson(url, params) {
  const c = await client();
  const res = await c.request({ url, params });
  return res.data;
}

/**
 * Пагінація за nextPageToken/pageToken — спільна для Asset Inventory
 * (results[]) і Compute globalAddresses (items[]).
 */
export async function paginate(url, params, itemsKey) {
  const out = [];
  let pageToken;
  do {
    const data = await getJson(url, { ...params, pageToken });
    out.push(...(data[itemsKey] || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}
