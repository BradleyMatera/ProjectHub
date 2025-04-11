const projects = [
  { name: "Gatsby Blog", desc: "A blogging app", url: "https://bradleysgatsbyblog.netlify.app" },
  { name: "Pokedex", desc: "Pokémon data app", url: "https://bradleymatera.github.io/Interactive-Pokedex" },
  { name: "Anime CRUD", desc: "Full-stack CRUD app", url: "https://cruddemo-one.vercel.app" },
  { name: "CheeseMath", desc: "Math library with Jest tests", url: "https://cheese-math.vercel.app" },
  { name: "WebGPU Renderer", desc: "2D shapes renderer (Chrome-only)", url: "https://bradleymatera.github.io/leaf-js" },
  { name: "Portfolio", desc: "Professional portfolio", url: "https://bradleymatera.github.io/Professional-Portfolio-Website" },
  { name: "Docker Multilang", desc: "Multi-language app with Docker", url: "https://github.com/BradleyMatera/docker_multilang_project" }
];
const chatDiv = document.createElement("div");
chatDiv.id = "bradley-chat";
chatDiv.innerHTML = "<input id=\"chat-input\" placeholder=\"Ask about my projects!\"><div id=\"chat-output\"></div>";
document.body.appendChild(chatDiv);
const input = document.getElementById("chat-input");
input.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    const query = input.value.toLowerCase();
    let reply = "I don’t know that one. Try asking about my projects!";
    projects.forEach(p => {
      if (query.includes(p.name.toLowerCase())) reply = `${p.name}: ${p.desc} - ${p.url}`;
    });
    document.getElementById("chat-output").innerHTML += `<p>${reply}</p>`;
    input.value = "";
  }
});
console.log("ProjectHub loaded!");
