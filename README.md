# ProjectHub

A CDN script that adds an AI-powered chat bot to your website, showcasing my web development projects, CodePens, and skills. The chat bot is designed to respond naturally to any input, remember the conversation context, and provide detailed insights into my work as a Web Development student at Full Sail University.

**Updated**: Fri Apr 11 13:31:22 CDT 2025

## Usage

To add the ProjectHub chat bot to your website, simply include the following script tag in your HTML:

```html
<script src="https://bradleymatera.github.io/ProjectHub/ProjectHub.js"></script>
```

This will add a chat interface to the bottom-right corner of your webpage, where users can interact with the bot to learn more about my projects, skills, and background.

## Features

- **AI-Powered Chat**: The bot uses an external AI to handle a wide range of queries naturally, even for unrelated topics, while prioritizing predefined responses for project-related questions.
- **Conversation Memory**: The bot remembers the conversation context, allowing for more coherent and personalized interactions.
- **Project Showcase**: Users can ask about my projects (e.g., "Tell me about Interactive Pokedex") or CodePens (e.g., "Tell me about React Calculator") to get detailed information, including descriptions, tech stacks, and links.
- **Bio and Skills**: Users can ask for a summary of me as a web developer (e.g., "Summarize Bradley as a web dev") to learn about my education, skills, certifications, and experience.
- **Natural Tone**: Responses are crafted in a casual, conversational tone to make interactions feel friendly and approachable.
- **Custom Queries**: The bot can handle any input, from project-related questions to general inquiries, by leveraging the AI to provide meaningful responses while steering the conversation back to my work when appropriate.
- **GitHub and LinkedIn Links**: Users can ask for my GitHub or LinkedIn profile (e.g., "What’s Bradley’s GitHub?") to get direct links and a brief overview of what they’ll find there.

## Examples

Here are some example queries you can try with the chat bot:

- **Project Inquiry**: "Tell me about Interactive Pokedex"  
  *Response*: "Interactive Pokedex: A Pokedex app built with HTML, Tailwind CSS, and JavaScript, integrating Pokemon APIs, created as part of my coursework to practice API integration. It’s hosted on GitHub Pages (https://bradleymatera.github.io/Interactive-Pokedex/). Source: https://github.com/BradleyMatera/Interactive-Pokedex (Stars: 0, Last Commit: Unknown). Tech used: HTML, Tailwind CSS, JavaScript, GitHub Pages."

- **CodePen Inquiry**: "Tell me about React Calculator"  
  *Response*: "React Calculator: A CodePen project I worked on as part of my learning. Check it out here: https://codepen.io/student-account-bradley-matera/pen/ogvGZjJ."

- **Summary Request**: "Summarize Bradley as a web dev"  
  *Response*: "I’m Bradley Matera, a Web Development student at Full Sail University, graduating in October 2025. I’ve been learning JavaScript, HTML, CSS, and tools like React, Node.js, and Tailwind CSS through my courses and self-study. I’ve worked on a few projects and CodePens, deploying them on platforms like GitHub Pages, Netlify, and Vercel, and I’m focused on building responsive, accessible web apps. Want to know more? Just ask for the 'full summary'!"

- **Full Summary**: "Full summary" (after asking for a summary)  
  *Response*: "Hey, I’m Bradley Matera, a Web Development student at Full Sail University since August 2023, working towards my B.S. with a 3.85 GPA—I’ll be graduating in October 2025. I’ve been learning web dev through my courses and on my own, mostly focusing on JavaScript, HTML, CSS, SQL, and C#. I’ve also gotten some experience with React, Gatsby, Next.js, React Native, Node.js, Express.js, MongoDB, Docker, Jest, PixiJS, WebGPU, and Tailwind CSS through school projects.<br><br>So far, I’ve worked on 10 projects and 7 CodePen projects, which I’ve deployed on platforms like GitHub Pages, Netlify, Vercel, GitHub using tools like Git, Netlify, Vercel, Heroku, and Docker. For example, my Interactive Pokedex project uses HTML, Tailwind CSS, and JavaScript to pull data from Pokemon APIs, and my WebGPU Shapes Renderer plays around with WebGPU for rendering shapes on a canvas.<br><br>I’m pretty comfortable styling with Tailwind CSS, Flexbox, and Grid, and I try to keep accessibility in mind by following ADA requirements. On the back-end, I’ve built a few RESTful APIs with Node.js and Express.js, connecting them to MongoDB or MySQL databases—like in my RESTful Routes Using ExpressJS project. I’ve also used Jest for unit testing, like in my CheeseMath Jest Tests project, and I’ve explored tools like PixiJS for real-time graphics, WebGPU for rendering, Postman for API testing, and Canvas for data visualizations. Some other projects I’ve done include interactive soundboards, Markdown previewers, quote generators, and bar chart visualizations.<br><br>I’ve earned a few certifications from freeCodeCamp, like JavaScript Algorithms and Data Structures, Responsive Web Design, and Foundational C# with Microsoft, plus some LinkedIn courses on personal branding, productivity, and communication. I’m still figuring things out as a developer, but I’m really passionate about coding and trying out new tech, and I’m always looking to get better."

- **General Query**: "What’s the weather like?"  
  *Response*: "I’m not sure about the weather, but I can tell you about my projects! For example, have you checked out my Interactive Pokedex? It’s a cool app I built with HTML, Tailwind CSS, and JavaScript to pull data from Pokemon APIs. Or you can ask for a summary about me as a web dev if you’d like to know more about my work!"

## Contributing

Feel free to fork this repository and submit pull requests if you have suggestions for improving the chat bot or adding new features. You can also open issues if you encounter any bugs or have feature requests.

## License

This project is licensed under the MIT License—see the [LICENSE](LICENSE) file for details.
```

### Changes Made
- **Expanded Overview**: Added a detailed description of the ProjectHub chat bot, explaining its purpose and functionality.
- **Updated Usage Instructions**: Kept the CDN script inclusion instructions but made them clearer with a code block.
- **Added Features Section**: Highlighted the key features of the chat bot, including AI integration, conversation memory, project showcase, bio/skill summaries, natural tone, custom query handling, and GitHub/LinkedIn links.
- **Included Examples**: Provided example queries and responses to demonstrate how the chat bot works, covering project inquiries, CodePen inquiries, summary requests, and general queries.
- **Added Contributing and License Sections**: Included standard sections for contributing to the project and licensing information to make the repository more professional and open-source-friendly.
- **Kept Update Timestamp**: Retained the existing update timestamp for consistency.

### Next Steps
- Save the updated `README.md` in the root of your `https://github.com/BradleyMatera/ProjectHub` repository.
- Stage, commit, and push the changes to GitHub:
  ```bash
  git add README.md
  git commit -m "Update README with detailed overview, features, examples, and contributing info"
  git push origin master