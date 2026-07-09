const projects = [
  { 
    name: "WebGPU Shapes Renderer", 
    desc: "A demo of a WebGPU-based renderer displaying selectable 2D shapes (triangle, square, pentagon, diamond, hexagon) on a canvas, forked and enhanced from an original project as part of coursework (only works on Chrome).", 
    url: "https://bradleymatera.github.io/leaf-js/", 
    platform: "GitHub Pages", 
    repo: "https://github.com/BradleyMatera/leaf-js", 
    tech: ["WebGPU", "JavaScript", "GitHub Pages"],
    apiEndpoint: null
  },
  { 
    name: "Gatsby Starter Minimal Blog", 
    desc: "A React-based blog fetching data from an Express API, deployed on Netlify as a learning project.", 
    url: "https://bradleysgatsbyblog.netlify.app/", 
    platform: "Netlify", 
    repo: "https://github.com/BradleyMatera/gatsby-starter-minimal-blog", 
    tech: ["React", "Express", "Netlify", "Gatsby"],
    apiEndpoint: "https://bradleysgatsbyblog.netlify.app/.netlify/functions/api"
  },
  { 
    name: "Interactive Pokedex", 
    desc: "A Pokedex app built with HTML, Tailwind CSS, and JavaScript, integrating Pokémon APIs, created to practice API integration.", 
    url: "https://bradleymatera.github.io/Interactive-Pokedex/", 
    platform: "GitHub Pages", 
    repo: "https://github.com/BradleyMatera/Interactive-Pokedex", 
    tech: ["HTML", "Tailwind CSS", "JavaScript", "GitHub Pages"],
    apiEndpoint: null
  },
  { 
    name: "Mom's Business Website", 
    desc: "A responsive website for my mom’s fitness business using HTML, CSS, and JavaScript, with a photo gallery and contact form, built to practice front-end skills.", 
    url: "https://bradleymatera.github.io/Moms-website/", 
    platform: "GitHub Pages", 
    repo: "https://github.com/BradleyMatera/Moms-website", 
    tech: ["HTML", "CSS", "JavaScript", "GitHub Pages"],
    apiEndpoint: null
  },
  { 
    name: "React Native Anime CRUD App", 
    desc: "A mobile CRUD app built with React Native, Node.js, and MongoDB, deployed on Vercel, created to learn mobile development and back-end integration.", 
    url: "https://cruddemo-one.vercel.app/", 
    platform: "Vercel", 
    repo: "https://github.com/BradleyMatera", 
    tech: ["React Native", "Node.js", "MongoDB", "Vercel"],
    apiEndpoint: "https://cruddemo-one.vercel.app/api/anime"
  },
  { 
    name: "Docker Multilang Project", 
    desc: "A Dockerized multi-language app (Python/Node.js) for server tooling, built to experiment with Docker.", 
    url: "https://github.com/BradleyMatera/docker_multilang_project", 
    platform: "GitHub", 
    repo: "https://github.com/BradleyMatera/docker_multilang_project", 
    tech: ["Docker", "Python", "Node.js", "GitHub"],
    apiEndpoint: null
  },
  { 
    name: "RESTful Routes Using ExpressJS", 
    desc: "A RESTful API built with Express.js and Node.js, connected to MongoDB, created to practice back-end development.", 
    url: "https://github.com/BradleyMatera/RESTfulRoutesUsingExpressJS", 
    platform: "GitHub", 
    repo: "https://github.com/BradleyMatera/RESTfulRoutesUsingExpressJS", 
    tech: ["Express", "Node.js", "MongoDB", "GitHub"],
    apiEndpoint: null
  },
  { 
    name: "Pong_Deluxe", 
    desc: "A Pong game using PixiJS for real-time graphics, deployed on Netlify, built to explore game development with JavaScript.", 
    url: "https://pongdeluxe.netlify.app/", 
    platform: "Netlify", 
    repo: "https://github.com/BradleyMatera/Pong-Deluxe", 
    tech: ["PixiJS", "JavaScript", "Netlify"],
    apiEndpoint: null
  },
  { 
    name: "CheeseMath Jest Tests", 
    desc: "Math utilities with Jest unit tests, deployed on Vercel, created to learn testing and debugging in JavaScript.", 
    url: "https://cheese-math.vercel.app/", 
    platform: "Vercel", 
    repo: "https://github.com/BradleyMatera/CheeseMath-Jest-Tests", 
    tech: ["JavaScript", "Jest", "Vercel"],
    apiEndpoint: null
  },
  { 
    name: "Animal Sounds", 
    desc: "An interactive soundboard app using HTML, CSS, and JavaScript, built as a fun project to practice front-end skills.", 
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