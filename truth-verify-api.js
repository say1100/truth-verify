// Truth Verify API client
// Put this file in the same folder as truth-verify-demov2.html, then include:
// <script src="./truth-verify-api.js"></script>

(function () {
  const DEFAULT_API_BASE_URL = window.location.protocol === 'file:'
    ? 'http://localhost:3000'
    : window.location.origin;

  function getApiBaseUrl() {
    return window.TRUTH_VERIFY_API_BASE_URL || DEFAULT_API_BASE_URL;
  }

  async function postJson(path, payload) {
    const url = `${getApiBaseUrl()}${path}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  async function verifyClaim(claim, options = {}) {
    if (!claim || !claim.trim()) {
      throw new Error('claim cannot be empty');
    }

    return postJson('/api/verify', {
      claim: claim.trim(),
      ...options
    });
  }

  async function compareSchools(schools) {
    if (!Array.isArray(schools) || schools.length === 0) {
      throw new Error('schools must be a non-empty array');
    }

    return postJson('/api/school-compare', {
      schools: schools.map((item) => String(item).trim()).filter(Boolean)
    });
  }

  async function getVerifyReports(options = {}) {
    const params = new URLSearchParams();
    if (options.q) params.set('q', options.q);
    if (options.limit) params.set('limit', String(options.limit));

    const query = params.toString();
    const url = `${getApiBaseUrl()}/api/verify-reports${query ? `?${query}` : ''}`;
    const response = await fetch(url);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${errorText}`);
    }

    return response.json();
  }

  window.TruthVerifyAPI = {
    getApiBaseUrl,
    verifyClaim,
    compareSchools,
    getVerifyReports
  };
})();
