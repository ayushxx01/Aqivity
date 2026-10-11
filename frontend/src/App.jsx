import { useState } from "react";
import "./App.css";

const LAMBDA_URL =
  "https://gpz2ain5ywcbxb7m55yhfo4xni0klbny.lambda-url.ap-south-1.on.aws/";

const POLLUTANTS = [
  "us_aqi",
  "pm10",
  "pm2_5",
  "ozone",
  "nitrogen_dioxide",
  "carbon_monoxide",
  "sulphur_dioxide",
];

// Open-Meteo timestamps are local to the timezone returned by the API,
// so derive the current hour in that timezone instead of the browser/Lambda timezone.
function getCurrentForecastIndex(data) {
  const times = data?.hourly?.time;
  if (!Array.isArray(times) || times.length === 0) return -1;

  const timezone = data.timezone || "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const currentHour = `${values.year}-${values.month}-${values.day}T${values.hour}:00`;
  const exactIndex = times.indexOf(currentHour);
  if (exactIndex !== -1) return exactIndex;

  // If the current hour isn't in the returned forecast, use the next available hour.
  return times.findIndex((time) => time >= currentHour);
}

function processAqiData(data) {
  if (!data?.hourly?.time) return null;

  const pivot = getCurrentForecastIndex(data);
  if (pivot < 0) return null;

  const result = {};
  for (const pollutant of POLLUTANTS) {
    const values = data.hourly[pollutant];
    if (Array.isArray(values)) result[pollutant] = values.slice(pivot, pivot + 6);
  }

  result.time = data.hourly.time.slice(pivot, pivot + 6);
  return result;
}

function formatForecastTime(timestamp) {
  if (!timestamp || timestamp === "Not determined") return "Not determined";
  // These API/model timestamps are timezone-local strings without an offset.
  // Parse the components as display values to avoid silently converting timezones.
  const match = timestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return timestamp;
  const [, year, month, day, hour, minute] = match;
  const displayDate = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute));
  return displayDate.toLocaleString([], {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getAqiLabel(value) {
  if (!Number.isFinite(value)) return "Unavailable";
  if (value <= 50) return "Good";
  if (value <= 100) return "Moderate";
  if (value <= 150) return "Unhealthy for sensitive groups";
  if (value <= 200) return "Unhealthy";
  if (value <= 300) return "Very unhealthy";
  return "Hazardous";
}

function App() {
  const [activity, setActivity] = useState("");
  const [latitude, setLatitude] = useState(null);
  const [longitude, setLongitude] = useState(null);
  const [locationError, setLocationError] = useState("");
  const [error, setError] = useState("");
  const [aqiData, setAqiData] = useState(null);
  const [processedData, setProcessedData] = useState(null);
  const [recommendation, setRecommendation] = useState(null);
  const [recommendationError, setRecommendationError] = useState("");
  const [loading, setLoading] = useState(false);

  function getLocation() {
    setLocationError("");
    if (!navigator.geolocation) {
      setLocationError("Geolocation is not supported by this browser.");
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLatitude(position.coords.latitude);
        setLongitude(position.coords.longitude);
        console.log("Location acquired:", position.coords.latitude, position.coords.longitude);
      },
      (err) => setLocationError(err.message),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function checkConditions() {
    setError("");
    setAqiData(null);
    setProcessedData(null);
    setRecommendation(null);
    setRecommendationError("");

    const requestedActivity = activity.trim();
    if (!requestedActivity) {
      setError("Enter an activity first.");
      return;
    }
    if (latitude === null || longitude === null) {
      setError("Please get your location first.");
      return;
    }

    setLoading(true);
    try {
      const url = new URL(LAMBDA_URL);
      url.search = new URLSearchParams({
        lat: String(latitude),
        lon: String(longitude),
        days: "1",
        activity: requestedActivity,
      }).toString();

      const response = await fetch(url);
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);

      let result = await response.json();
      // This also makes the frontend tolerant of a Lambda-console-style proxy wrapper.
      if (typeof result.body === "string") {
        try {
          result = JSON.parse(result.body);
        } catch {
          throw new Error("The server returned an unreadable response.");
        }
      }

      if (!result.forecast) {
        throw new Error(result.error || "The response did not include forecast data.");
      }

      setAqiData(result.forecast);
      setProcessedData(processAqiData(result.forecast));
      setRecommendation(result.recommendation || null);
      setRecommendationError(result.recommendationError || "");
    } catch (err) {
      console.error(err);
      setError(err.message || "Unable to fetch conditions. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  const currentAqi = processedData?.us_aqi?.[0];
  const nextHours = (processedData?.us_aqi || [])
    .slice(1)
    .map((value, index) => ({ value, time: processedData.time[index + 1] }))
    .filter((item) => Number.isFinite(item.value));

  const betterWindow = nextHours.length
    ? nextHours.reduce((best, item) => (item.value < best.value ? item : best))
    : null;

  const recommendationTimeIsInForecast =
    recommendation?.bestTime &&
    recommendation.bestTime !== "Not determined" &&
    aqiData?.hourly?.time?.includes(recommendation.bestTime);

  return (
    <main className="app">
      <header className="hero">
        <div className="brand-mark">✳</div>
        <p className="eyebrow">YOUR OUTDOOR COMPANION</p>
        <h1>Aqivity</h1>
        <p className="subtitle">Better air awareness. Smarter outdoor plans.</p>
      </header>

      <section className="input-card">
        <label htmlFor="activity">What are you planning?</label>
        <input
          id="activity"
          value={activity}
          onChange={(event) => setActivity(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") checkConditions();
          }}
          placeholder="e.g. Running, cycling, a long walk..."
          maxLength={120}
        />

        <button type="button" className="location-button" onClick={getLocation}>
          <span>⌖</span>
          {latitude !== null && longitude !== null ? "Refresh my location" : "Use my location"}
        </button>

        {latitude !== null && longitude !== null && (
          <p className="location-status"><span className="status-dot" />Location acquired</p>
        )}
        {locationError && <p className="error-message" role="alert">{locationError}</p>}

        <button type="button" className="assess-button" onClick={checkConditions} disabled={loading}>
          {loading ? <><span className="spinner" />Assessing conditions...</> : <>Assess conditions <span>↗</span></>}
        </button>
        {error && <p className="error-message" role="alert">{error}</p>}
      </section>

      {loading && (
        <section className="loading-card" aria-live="polite">
          <span className="spinner" />
          <div><strong>Checking your conditions</strong><p>Fetching the forecast and generating your activity recommendation...</p></div>
        </section>
      )}

      {aqiData && !loading && (
        <section className="results">
          <div className="section-heading">
            <div><p className="eyebrow">YOUR CONDITIONS</p><h2>Here's your outlook</h2></div>
            <span className="live-indicator">● DATA RECEIVED</span>
          </div>

          <article className="result-card aqi-card">
            <p className="card-label">CURRENT AIR QUALITY</p>
            {Number.isFinite(currentAqi) ? (
              <div className="aqi-value-row">
                <div><h3>{currentAqi}</h3><p>US AQI</p></div>
                <span className="aqi-badge">{getAqiLabel(currentAqi)}</span>
              </div>
            ) : (
              <div className="pending-result"><h3>—</h3><p>Current AQI is unavailable for the selected forecast window.</p></div>
            )}
          </article>

          <article className="result-card recommendation-card">
            <p className="card-label">FOR YOUR ACTIVITY · {activity.trim()}</p>
            {recommendation ? (
              <>
                <h3>{recommendation.recommendation || "Recommendation unavailable"}</h3>
                <p>{recommendation.explanation || "No explanation was provided."}</p>
                <div className="recommendation-meta">
                  <p><strong>Suggested time:</strong> {recommendationTimeIsInForecast ? formatForecastTime(recommendation.bestTime) : "Not verified against the forecast"}</p>
                  <p><strong>Why:</strong> {recommendation.reason || "No reason was provided."}</p>
                </div>
                {!recommendationTimeIsInForecast && recommendation.bestTime && recommendation.bestTime !== "Not determined" && (
                  <p className="muted-note">The model suggested a time that wasn't found in the returned forecast, so it isn't shown as a verified window.</p>
                )}
                <p className="muted-note">This is an AI-generated advisory, not medical advice or a guarantee that activity is safe.</p>
              </>
            ) : (
              <>
                <h3>Recommendation unavailable</h3>
                <p>{recommendationError || "Air-quality data loaded, but no recommendation was returned."}</p>
                <span className="pending-label">Forecast available · AI recommendation unavailable</span>
              </>
            )}
          </article>

          <article className="result-card window-card">
            <p className="card-label">NEXT FIVE HOURS</p>
            {betterWindow ? (
              <>
                <h3>Lowest forecast AQI in the upcoming hours</h3>
                <p>{formatForecastTime(betterWindow.time)}</p>
                <p>Forecast US AQI: <strong>{betterWindow.value}</strong></p>
                <p className="muted-note">This compares AQI only. Other pollutants and activity intensity may also matter; a lower AQI does not guarantee safety.</p>
              </>
            ) : (
              <><h3>Time-window analysis unavailable</h3><p>There aren't enough upcoming AQI values to compare.</p></>
            )}
          </article>

          <details className="pollutant-details">
            <summary>View pollutant forecast data</summary>
            <div className="pollutant-list">
              {POLLUTANTS.filter((key) => key !== "us_aqi").map((key) => (
                <div className="pollutant-row" key={key}>
                  <span>{key.replaceAll("_", ".").toUpperCase()}</span>
                  <strong>{processedData?.[key]?.[0] ?? "Unavailable"}</strong>
                </div>
              ))}
            </div>
            <p className="muted-note">Pollutant values are in the units supplied by the API. Forecasts are modelled estimates, not necessarily measurements from a nearby monitoring station.</p>
          </details>
        </section>
      )}

      <footer className="footer"><span>✳</span> Make informed plans. Breathe easier.</footer>
    </main>
  );
}

export default App;
