import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:5000';
const EMAIL = __ENV.EMAIL || 'admin@galien.com';
const PASSWORD = __ENV.PASSWORD || 'admin123';
const TARGET_VUS = Number(__ENV.TARGET_VUS || 10);
const RAMP_UP = __ENV.RAMP_UP || '20s';
const HOLD = __ENV.HOLD || '40s';
const RAMP_DOWN = __ENV.RAMP_DOWN || '20s';

export const options = {
  setupTimeout: '90s',
  scenarios: {
    main: {
      executor: 'ramping-vus',
      startVUs: 1,
      stages: [
        { duration: RAMP_UP, target: TARGET_VUS },
        { duration: HOLD, target: TARGET_VUS },
        { duration: RAMP_DOWN, target: 0 }
      ],
      gracefulRampDown: '10s'
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<1200']
  }
};

const loginTrend = new Trend('login_duration_ms');

export function setup() {
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, timeout: '20s' }
  );

  loginTrend.add(res.timings.duration);

  const ok = check(res, {
    'login status is 200': (r) => r.status === 200,
    'login has token': (r) => !!r.json('token')
  });

  if (!ok) {
    throw new Error(`Login failed: ${res.status} ${res.body}`);
  }

  return { token: res.json('token') };
}

export default function (data) {
  const headers = {
    Authorization: `Bearer ${data.token}`,
    'Content-Type': 'application/json'
  };

  const health = http.get(`${BASE_URL}/health`);
  check(health, { 'health is 200': (r) => r.status === 200 });

  const modules = http.get(`${BASE_URL}/api/modules`, { timeout: '20s' });
  check(modules, { 'modules is 200': (r) => r.status === 200 });

  const questions = http.get(`${BASE_URL}/api/questions?page=1&page_size=20`, { headers, timeout: '20s' });
  let parsedQuestions = null;
  try {
    parsedQuestions = questions.json();
  } catch (e) {
    parsedQuestions = null;
  }
  const isQuestionsArray =
    Array.isArray(parsedQuestions) ||
    Array.isArray(parsedQuestions?.questions) ||
    Array.isArray(parsedQuestions?.data);
  check(questions, {
    'questions is 200': (r) => r.status === 200,
    'questions payload valid': () => isQuestionsArray
  });

  const stats = http.get(`${BASE_URL}/api/users/stats`, { headers, timeout: '20s' });
  check(stats, { 'stats is 200': (r) => r.status === 200 });

  sleep(1);
}
