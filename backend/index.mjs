
const jsonHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  };
  
  function reply(statusCode, payload) {
    return {
      statusCode,
      headers: jsonHeaders,
      body: JSON.stringify(payload)
    };
  }
  
  async function getGemmaRecommendation(activity, data) {
    const apiKey = process.env.bedrock_api_key;
    const model = process.env.bedrock_model_id;
    const baseUrl = process.env.bedrock_base_url;
  
    if (!apiKey || !model || !baseUrl) {
      throw new Error("Bedrock environment variables are missing");
    }
  
    // Send a compact snapshot instead of the entire forecast.
    const hourly = data.hourly;
    const now = new Date();
    const currentHour = now.getHours();
  
    let index = hourly.time.findIndex((time) => {
      return Number(time.split("T")[1].split(":")[0]) === currentHour;
    });
  
    if (index < 0) index = 0;
  
    const snapshot = {
      timezone: data.timezone,
      time: hourly.time.slice(index, index + 6),
      us_aqi: hourly.us_aqi?.slice(index, index + 6),
      pm2_5: hourly.pm2_5?.slice(index, index + 6),
      pm10: hourly.pm10?.slice(index, index + 6),
      ozone: hourly.ozone?.slice(index, index + 6),
      nitrogen_dioxide: hourly.nitrogen_dioxide?.slice(index, index + 6),
      carbon_monoxide: hourly.carbon_monoxide?.slice(index, index + 6),
      sulphur_dioxide: hourly.sulphur_dioxide?.slice(index, index + 6)
    };
  
    const prompt = `
  You are Activity Guardian, an air-quality activity advisor.
  
  Use only the supplied forecast data. Do not invent readings,
  AQI thresholds, medical facts, or forecast times.
  
  Assess the requested activity using the overall US AQI,
  pollutant readings, and exertion level. Running and other
  vigorous activities involve greater breathing rates than
  light activity. Do not claim any activity is medically safe.
  
  Return ONLY valid JSON in this exact shape:
  {
    "recommendation": "Proceed cautiously",
    "explanation": "A concise explanation based on the data.",
    "bestTime": "A forecast time, or Not determined",
    "reason": "A short reason for the suggested time."
  }
  
  Recommendation must be one of:
  "Proceed cautiously", "Modify activity", "Prefer indoors",
  or "Insufficient data".
  
  Choose bestTime only from supplied forecast times. If the
  data does not support a useful time recommendation, return
  "Not determined". Explain uncertainty when relevant.
  
  Activity: ${activity}
  Forecast JSON: ${JSON.stringify(snapshot)}
  `;
  
    const response = await fetch(
      `${baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content: "Return only valid JSON. Follow the requested schema."
            },
            { role: "user", content: prompt }
          ],
          temperature: 0.2,
          max_tokens: 300
        })
      }
    );
  
    if (!response.ok) {
      const details = await response.text();
      console.error("Bedrock error:", response.status, details);
      throw new Error(`Bedrock request failed (${response.status})`);
    }
  
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
  
    if (!content) {
      throw new Error("Bedrock returned an empty response");
    }
  
    // Reject malformed model output instead of silently displaying it.
    const cleaned = content
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();
  
    return JSON.parse(cleaned);
  }
  
  export const handler = async (event) => {
    try {
      const params = event.queryStringParameters ?? {};
  
      const lat = Number(params.lat);
      const lon = Number(params.lon);
      const forecastDays = Number(params.days ?? 1);
      const activity = String(params.activity ?? "").trim();
  
      if (
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        lat < -90 || lat > 90 ||
        lon < -180 || lon > 180 ||
        !Number.isInteger(forecastDays) ||
        forecastDays < 1 || forecastDays > 5
      ) {
        return reply(400, {
          error: "Valid lat, lon and days are required"
        });
      }
  
      if (!activity || activity.length > 120) {
        return reply(400, {
          error: "Provide an activity of 1–120 characters"
        });
      }
  
      const url = new URL(
        "https://air-quality-api.open-meteo.com/v1/air-quality"
      );
  
      url.search = new URLSearchParams({
        latitude: String(lat),
        longitude: String(lon),
        hourly:
          "us_aqi,pm10,pm2_5,ozone,nitrogen_dioxide,carbon_monoxide,sulphur_dioxide",
        forecast_days: String(forecastDays),
        timezone: "auto"
      }).toString();
  
      const response = await fetch(url);
  
      if (!response.ok) {
        throw new Error(`Open-Meteo returned ${response.status}`);
      }
  
      const data = await response.json();
  
      let recommendation;
  
      try {
        recommendation = await getGemmaRecommendation(activity, data);
      } catch (error) {
        console.error("Recommendation error:", error);
  
        // Keep the real forecast available even if the model fails.
        return reply(200, {
          forecast: data,
          recommendation: null,
          recommendationError:
            "Air-quality data loaded, but the AI recommendation failed."
        });
      }
  
      return reply(200, {
        forecast: data,
        recommendation,
        recommendationError: null
      });
    } catch (error) {
      console.error("Handler error:", error);
  
      return reply(502, {
        error: "Unable to fetch air-quality data"
      });
    }
  };
  