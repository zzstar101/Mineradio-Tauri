import { expect, test } from "bun:test";
import weatherEnvelope from "../fixtures/weather-radio-envelope.json";
import { CoverSourceSchema, inspectCoverSource } from "./cover-source";
import { WeatherRadioResponseSchema } from "./weather";

const EXPECTED_CAPTURED_HOSTS = {
  qq: "y.gtimg.cn",
  netease: "p2.music.126.net",
  soda: "p3-luna.douyinpic.com"
} as const;

test("captured Rust weather-radio JSON preserves semantic provider cover sources", () => {
  const response = WeatherRadioResponseSchema.parse(weatherEnvelope.data);
  for (const [provider, expectedHost] of Object.entries(EXPECTED_CAPTURED_HOSTS)) {
    const track = response.radio.songs.find((candidate) => candidate.provider === provider);
    expect(Boolean(track)).toBe(true);
    const cover = CoverSourceSchema.parse(track?.coverUrl ?? "");
    const inspected = inspectCoverSource(cover);
    expect(inspected.kind).toBe("remote");
    expect(new URL(inspected.normalized).hostname).toBe(expectedHost);
  }
});

test("captured semantic covers never include the QQ empty-mid artifact", () => {
  const response = WeatherRadioResponseSchema.parse(weatherEnvelope.data);
  expect(response.radio.songs.every((track) => !track.coverUrl.endsWith("M000.jpg"))).toBe(true);
});
