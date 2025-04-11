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
chatDiv.style.position = "fixed";
chatDiv.style.bottom = "20px";
chatDiv.style.right = "20px";
chatDiv.style.width = "300px";
chatDiv.style.background = "#333";
chatDiv.style.borderRadius = "10px";
chatDiv.style.padding = "10px";
chatDiv.style.color = "#fff";
chatDiv.style.boxShadow = "0 0 15px rgba(0, 216, 255, 0.5)";
chatDiv.style.fontFamily = "Arial, sans-serif";
chatDiv.innerHTML = "<div style=\"margin-bottom: 10px; font-weight: bold;\">Bradley\'s Project Chat</div><input id=\"chat-input\" placeholder=\"Ask about my projects!\" style=\"width: 100%; padding: 5px; border-radius: 5px; border: none; margin-bottom: 10px;\"><div id=\"chat-output\" style=\"max-height: 300px; overflow-y: auto;\"><p>Welcome! Ask about my projects (e.g., Pokedex, Anime CRUD).</p></div>";
document.body.appendChild(chatDiv);
const input = document.getElementById("chat-input");
const output = document.getElementById("chat-output");
input.addEventListener("keypress", (e) => {
  if (e.key === "Enter") {
    const query = input.value.toLowerCase();
    let reply = "I don’t know that one. Try asking about my projects (e.g., Pokedex, Anime CRUD)!";
    if (query.includes("list") || query.includes("all")) {
      reply = "Here are my projects: " + projects.map(p => p.name).join(", ") + ".";
    } else {
      projects.forEach(p => {
        if (query.includes(p.name.toLowerCase())) reply = `${p.name}: ${p.desc} - ${p.url}`;
      });
    }
    output.innerHTML += `<p>${reply}</p>`;
    output.scrollTop = output.scrollHeight;
    input.value = "";
  }
});
console.log("ProjectHub loaded!");