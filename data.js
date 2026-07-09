const projects = [
  {
    name: "AWS Serverless Metadata Extraction Workflow",
    desc: "AWS internship capstone that extracts metadata with Lambda, DynamoDB, S3, and an accessible frontend on AWS Amplify.",
    url: null,
    platform: "AWS",
    repo: "https://github.com/BradleyMatera",
    tech: ["AWS Lambda", "Amazon DynamoDB", "Amazon S3", "AWS Amplify"],
    apiEndpoint: null
  },
  {
    name: "AWS Infrastructure Cost-Analysis Model",
    desc: "Transparent cost model using measurable cloud inputs such as request counts, GB-month, compute time, read/write units, and transfer out.",
    url: null,
    platform: "AWS",
    repo: "https://github.com/BradleyMatera",
    tech: ["AWS usage metrics", "Data analysis", "Modeling"],
    apiEndpoint: null
  },
  {
    name: "CIRIS Ethical AI",
    desc: "Freelance contributor work on a real open-source project: local setup, onboarding docs, small code updates, JWT guidance, debugging, and GitHub issue tracking.",
    url: null,
    platform: "GitHub",
    repo: "https://github.com/BradleyMatera",
    tech: ["JavaScript", "Docker Compose", "GitHub", "JWT"],
    apiEndpoint: null
  },
  {
    name: "ProjectHub",
    desc: "Embeddable AI-powered chat widget that showcases Bradley's web development projects and CodePens. Served from GitHub Pages as a single script.",
    url: "https://bradleymatera.github.io/ProjectHub/",
    platform: "GitHub Pages",
    repo: "https://github.com/BradleyMatera/ProjectHub",
    tech: ["JavaScript", "GitHub Pages"],
    apiEndpoint: null
  },
  {
    name: "Interactive Pokedex",
    desc: "Static Gen 1 Pokedex UI with all 151 entries, client-side search/filtering, data display, and theme controls.",
    url: "https://bradleymatera.github.io/Interactive-Pokedex/",
    platform: "GitHub Pages",
    repo: "https://github.com/BradleyMatera/Interactive-Pokedex",
    tech: ["JavaScript", "HTML", "CSS"],
    apiEndpoint: null
  },
  {
    name: "CheeseMath",
    desc: "Calculator and testing demo with arithmetic, string operations, regex analysis, input handling, and Jest validation.",
    url: "https://bradleymatera.github.io/CheeseMath-Jest-Tests/",
    platform: "GitHub Pages",
    repo: "https://github.com/BradleyMatera/CheeseMath-Jest-Tests",
    tech: ["JavaScript", "Jest"],
    apiEndpoint: null
  },
  {
    name: "Secrets & Environment Variables Demo",
    desc: "Educational frontend demo showing why secrets should not be hardcoded and how environment-variable concepts apply to application configuration.",
    url: "https://bradleymatera.github.io/EthicsFrontEndDemo/",
    platform: "GitHub Pages",
    repo: "https://github.com/BradleyMatera/EthicsFrontEndDemo",
    tech: ["JavaScript", "HTML", "CSS"],
    apiEndpoint: null
  },
  {
    name: "Animal Sounds",
    desc: "Interactive animal soundboard UI with audio playback and responsive frontend styling.",
    url: "https://bradleymatera.github.io/AnimalSounds/",
    platform: "GitHub Pages",
    repo: "https://github.com/BradleyMatera/AnimalSounds",
    tech: ["JavaScript", "HTML", "CSS"],
    apiEndpoint: null
  },
  {
    name: "Triangle Shader Lab",
    desc: "WebGPU learning demo with hello-triangle and textured-cube examples in a browser-based layout.",
    url: "https://bradleymatera.github.io/TriangleDemo/",
    platform: "GitHub Pages",
    repo: "https://github.com/BradleyMatera/TriangleDemo",
    tech: ["WebGPU", "JavaScript", "HTML"],
    apiEndpoint: null
  },
  {
    name: "Fallen Knight: Requiem of Honor",
    desc: "KAJAM game jam project built with classmates, ranked #9 in Artstyle.",
    url: "https://itch.io/jam/kajam/rate/3114394",
    platform: "itch.io",
    repo: "https://github.com/BradleyMatera",
    tech: [],
    apiEndpoint: null
  }
];

const codePens = [
  { name: "JavaScript Garbage Collection Tutorial", url: "https://codepen.io/student-account-bradley-matera/pen/ZYzoWpL" },
  { name: "React Calculator", url: "https://codepen.io/student-account-bradley-matera/pen/ogvGZjJ" },
  { name: "Sound Machine", url: "https://codepen.io/student-account-bradley-matera/details/dPbVvoa" },
  { name: "Markdown Previewer", url: "https://codepen.io/student-account-bradley-matera/pen/ZYzXeEJ" },
  { name: "Random Quote Machine", url: "https://codepen.io/student-account-bradley-matera/pen/azoLpeG" },
  { name: "Random Quote Generator", url: "https://codepen.io/student-account-bradley-matera/pen/PwYJWMY" },
  { name: "Data Visualization", url: "https://codepen.io/student-account-bradley-matera/details/dyEYbPO" }
];

// Dropdown suggestions
const suggestions = [
  "Summarize Bradley as a junior software engineer",
  "What’s Bradley’s GitHub?",
  "What’s Bradley’s LinkedIn?",
  "Tell me about ProjectHub",
  "Tell me about the AWS serverless workflow",
  "Tell me about CIRIS Ethical AI",
  "List all projects",
  "List all CodePens",
  "What roles is Bradley targeting?",
  "What is Bradley’s strongest technical background?"
];