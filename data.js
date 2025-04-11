const projects = [
  { 
    name: "WebGPU Shapes Renderer", 
    desc: "Demo of a WebGPU-based renderer displaying selectable 2D shapes (triangle, square, pentagon, diamond, hexagon) on a canvas, forked and enhanced from an original project (only works on Chrome).", 
    url: "https://bradleymatera.github.io/leaf-js/", 
    platform: "GitHub Pages", 
    repo: "https://github.com/BradleyMatera/leaf-js", 
    tech: ["WebGPU", "JavaScript", "GitHub Pages"],
    apiEndpoint: null
  },
  { 
    name: "Gatsby Starter Minimal Blog", 
    desc: "React-based blog fetching data from an Express API, deployed on Netlify.", 
    url: "https://bradleysgatsbyblog.netlify.app/", 
    platform: "Netlify", 
    repo: "https://github.com/BradleyMatera/gatsby-starter-minimal-blog", 
    tech: ["React", "Express", "Netlify"],
    apiEndpoint: "https://bradleysgatsbyblog.netlify.app/.netlify/functions/api"
  },
  { 
    name: "Interactive Pokedex", 
    desc: "An engaging Pokedex application built with HTML, Tailwind CSS, and JavaScript, integrating Pokémon APIs.", 
    url: "https://bradleymatera.github.io/Interactive-Pokedex/", 
    platform: "GitHub Pages", 
    repo: "https://github.com/BradleyMatera/Interactive-Pokedex", 
    tech: ["HTML", "Tailwind CSS", "JavaScript", "GitHub Pages"],
    apiEndpoint: null
  },
  { 
    name: "Mom's Business Website", 
    desc: "A responsive website for my mom’s fitness business using HTML, CSS, and JavaScript, with a photo gallery and contact form.", 
    url: "https://bradleymatera.github.io/Moms-website/", 
    platform: "GitHub Pages", 
    repo: "https://github.com/BradleyMatera/Moms-website", 
    tech: ["HTML", "CSS", "JavaScript", "GitHub Pages"],
    apiEndpoint: null
  },
  { 
    name: "React Native Anime CRUD App", 
    desc: "Mobile CRUD app with React Native, Node.js, MongoDB, deployed on Vercel.", 
    url: "https://cruddemo-one.vercel.app/", 
    platform: "Vercel", 
    repo: "https://github.com/BradleyMatera",
    tech: ["React Native", "Node.js", "MongoDB", "Vercel"],
    apiEndpoint: "https://cruddemo-one.vercel.app/api/anime"
  },
  { 
    name: "Docker Multilang Project", 
    desc: "Dockerized multi-language app (Python/Node.js) for server tooling.", 
    url: "https://github.com/BradleyMatera/docker_multilang_project", 
    platform: "GitHub", 
    repo: "https://github.com/BradleyMatera/docker_multilang_project", 
    tech: ["Docker", "Python", "Node.js", "GitHub"],
    apiEndpoint: null
  },
  { 
    name: "RESTful Routes Using ExpressJS", 
    desc: "RESTful API built with Express.js.", 
    url: "https://github.com/BradleyMatera/RESTfulRoutesUsingExpressJS", 
    platform: "GitHub", 
    repo: "https://github.com/BradleyMatera/RESTfulRoutesUsingExpressJS", 
    tech: ["Express", "Node.js", "GitHub"],
    apiEndpoint: null
  },
  { 
    name: "Pong_Deluxe", 
    desc: "Pong game using PixiJS for real-time graphics, deployed on Netlify.", 
    url: "https://pongdeluxe.netlify.app/", 
    platform: "Netlify", 
    repo: "https://github.com/BradleyMatera/Pong-Deluxe", 
    tech: ["PixiJS", "JavaScript", "Netlify"],
    apiEndpoint: null
  },
  { 
    name: "CheeseMath Jest Tests", 
    desc: "Math utilities with Jest unit tests, deployed on Vercel.", 
    url: "https://cheese-math.vercel.app/", 
    platform: "Vercel", 
    repo: "https://github.com/BradleyMatera/CheeseMath-Jest-Tests", 
    tech: ["JavaScript", "Jest", "Vercel"],
    apiEndpoint: null
  },
  { 
    name: "Animal Sounds", 
    desc: "Animal Sounds app.", 
    url: "https://bradleymatera.github.io/AnimalSounds/", 
    platform: "GitHub Pages", 
    repo: "https://github.com/BradleyMatera/AnimalSounds", 
    tech: ["HTML", "CSS", "JavaScript", "GitHub Pages"],
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
  "What project has the most stars?",
  "Summarize Bradley as a web dev",
  "What’s Bradley’s GitHub?",
  "What’s Bradley’s LinkedIn?",
  "Tell me about Interactive Pokedex",
  "Tell me about React Calculator",
  "List all projects",
  "List all CodePens",
  "Compare Pokedex and Pong_Deluxe",
  "What projects use React?"
];