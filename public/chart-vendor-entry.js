// ABOUTME: Bundles Chart.js as a Picot same-origin asset.
// ABOUTME: Usage dashboard charts must not fetch a remote CDN script.
import Chart from "chart.js/auto";

globalThis.Chart = Chart;
