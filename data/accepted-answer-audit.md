# Accepted Answer Audit — 1.5B Run (config C, 68 questions, 46 accepted)

Verified knowledge baseline: `data/recruiter-knowledge.json`

Key verified facts used as ground truth:

- **ProjectHub (Scout)**: Embeddable AI recruiter assistant. Tech: JavaScript, Node.js, Express, GitHub Pages, GCP e2-micro, Caddy, Vite, Carbon Design System, Ollama, Qwen 2.5, Okapi BM25, RAG, Conversational memory. **NOT built at AWS. NOT during Amazon time.**
- **Interactive Pokedex**: Static Gen 1 Pokedex UI. Tech: JavaScript, HTML, CSS. **NOT AWS capstone. NOT React. NOT Node.js. NOT WebGPU.**
- **CheeseMath**: Calculator and testing demo. Tech: JavaScript, Jest.
- **Triangle Shader Lab**: WebGPU learning demo. Tech: WebGPU, JavaScript, HTML. **This is the WebGPU project.**
- **AWS Serverless Metadata Extraction Workflow**: AWS internship capstone. Tech: AWS Lambda, DynamoDB, S3, AWS Amplify. **NOT React. NOT Node.js (not listed). NOT WebGPU. NOT the Interactive Pokedex.**
- **CIRIS Ethical AI**: Freelance contributor. Tech: JavaScript, Docker Compose, GitHub, JWT.
- **Voice Ops Platform**: Authenticated operations platform. Tech: JavaScript, Node.js, AI, Operations.
- AWS internship: Cloud Support Engineer Intern, May-Aug 2025. Internship. Guided training environments. NOT production. NOT senior.
- Education: B.S. Web Development, Full Sail University. NOT MIT. NOT CS. NOT master's.
- Certifications: AWS SAA, AWS AI Practitioner, freeCodeCamp JS, freeCodeCamp RWD. NOT Kubernetes.
- React: in skills list, studied in school. NOT specifically tied to AWS capstone in knowledge.
- WebGPU: used in Triangle Shader Lab. NOT real-time audio. NOT in Pokedex.

---

## AUDIT RESULTS

### 1. "Tell me about ProjectHub."
**A:** "ProjectHub is a project management tool developed by Bradley Matera during his time at Amazon. It's designed to help individuals manage their personal projects more efficiently... The tool integrates well with other Amazon services like AWS Lambda, S3, and CloudFront, demonstrating his expertise in backend development and cloud infrastructure."
**Classification: WRONG_ENTITY_ASSOCIATION + WRONG_EMPLOYMENT_ASSOCIATION + OVERCLAIM**
- ProjectHub is NOT a project management tool. It is an AI recruiter assistant.
- ProjectHub was NOT developed during his time at Amazon. It is independent.
- ProjectHub does NOT integrate with AWS Lambda/S3/CloudFront.
- "expertise" is overclaim.
**VERDICT: FACTUALLY WRONG. Validator false accept.**

### 2. "Okay, but what's actually interesting about it?"
**A:** "Interesting about it is that he has extensive experience in backend development with skills in multiple frameworks and services including AWS..."
**Classification: OVERCLAIM + GENERIC**
- "extensive experience" is overclaim per rules.
- Doesn't answer the question about ProjectHub.
**VERDICT: FACTUALLY WRONG (overclaim) + non-answer.**

### 3. "What did Bradley personally build?"
**A:** "Bradley personally built the CheeseMath project. This interactive tool allows users to practice mathematical operations..."
**Classification: FACTUALLY_CORRECT_BUT_INCOMPLETE**
- CheeseMath is verified. Description is roughly correct.
- But ignores the question scope (he built many things).
**VERDICT: FACTUALLY CORRECT but generic/incomplete.**

### 4. "What was the hardest technical part?"
**A:** "He found the hardest technical part to be implementing the real-time audio feature using WebGPU due to its complexity in managing graphics and performance efficiently."
**Classification: WRONG_ENTITY_ASSOCIATION + FABRICATION**
- WebGPU is used in Triangle Shader Lab (hello-triangle, textured-cube), NOT real-time audio.
- No "real-time audio feature" exists anywhere in knowledge.
- No "hardest technical part" is stated anywhere.
**VERDICT: FACTUALLY WRONG. Validator false accept.**

### 5. "What has he actually done with AWS?"
**A:** "Bradley Matera has used AWS services such as AWS Lambda, DynamoDB, and S3 to create projects involving serverless computing and data storage. His experience includes working with AWS Amplify to develop mobile applications and utilizing AWS usage metrics to monitor service performance."
**Classification: WRONG_ENTITY_ASSOCIATION (partial)**
- Lambda, DynamoDB, S3, Amplify, usage metrics: all verified for AWS internship.
- "develop mobile applications" — Amplify was used for accessible frontend, not specifically mobile applications. Mild overclaim.
**VERDICT: MOSTLY CORRECT, one mild overclaim.**

### 6. "So what did he actually learn there?"
**A:** "As a software engineer intern at Amazon, Bradley Matera learned to use AWS services such as DynamoDB and S3, which were crucial for managing data storage and serving static content efficiently on his project, the Interactive Pokedex. Additionally, his internship experience allowed him to gain hands-on experience with AWS Lambda..."
**Classification: WRONG_PROJECT_ASSOCIATION**
- "Interactive Pokedex" was NOT his AWS internship project. The AWS capstone was the "AWS Serverless Metadata Extraction Workflow."
- Pokedex is a separate static frontend demo.
**VERDICT: FACTUALLY WRONG. Validator false accept.**

### 7. "Does that count as real cloud experience?"
**A:** "his AWS internship project involved using AWS services to build a serverless system, which provides practical experience with cloud technologies."
**Classification: FACTUALLY_CORRECT**
**VERDICT: FACTUALLY CORRECT.**

### 8. "What AWS certifications does he have?"
**A:** "He has AWS Certified Solutions Architect Associate certification."
**Classification: FACTUALLY_CORRECT_BUT_INCOMPLETE**
- Correct but missing AWS Certified AI Practitioner.
**VERDICT: FACTUALLY CORRECT (incomplete).**

### 9. "Give me the quick version."
**A:** "Bradley Matera is a software engineer with skills in JavaScript, HTML, CSS, Jest, WebGPU, AWS Lambda, DynamoDB, S3, AWS Amplify, and AWS usage metrics. He has worked on projects like Interactive Pokedex, CheeseMath, and Secrets & Environm…."
**Classification: FACTUALLY_CORRECT_BUT_GENERIC**
- Skills and projects listed are all verified.
- Missing TypeScript, React, Node.js, Next.js, SQL.
**VERDICT: FACTUALLY CORRECT (incomplete).**

### 10. "Why would I interview him?"
**A:** "He has extensive experience in front-end web development, including working with frameworks like React to create interactive applications. His skills in front-end technologies align well with modern web development trends and challenges. Additionally, his knowledge of AWS services suggests he's adept at handling cloud infrastructure and deployment. His projects demonstrate proficiency in both frontend and backend development, making him versatile and adaptable. His involvement in AWS Amplify suggests he's familiar with modern web development practices and tools. His technical expertise in areas like Jest and WebGPU demonstrates a strong understanding of testing and performance optimization."
**Classification: OVERCLAIM**
- "extensive experience" — overclaim per rules.
- "expertise" — overclaim per rules.
- "adept at handling cloud infrastructure and deployment" — overclaim.
- React is in skills but no specific project uses React in knowledge base.
**VERDICT: FACTUALLY WRONG (overclaim).**

### 11. "What kind of role fits him best?"
**A:** "Bradley Matera's role that fits him best would be one involving technical skills and project management, given his expertise in JavaScript, HTML, CSS, Jest, AWS Lambda, and DynamoDB. His experience in AWS services and cloud computing aligns well with roles requiring proficiency in serverless architectures and microservices. Additionally, his background in AWS Amplify suggests he would thrive in environments where client-side technologies and serverless solutions are integrated seamlessly into applications."
**Classification: OVERCLAIM**
- "expertise" — overclaim.
- "microservices" — not in knowledge.
**VERDICT: FACTUALLY WRONG (overclaim).**

### 12. "What's the strongest evidence that he can actually build software?"
**A:** "The strongest evidence that Bradley Matera can build software comes from his extensive projects and skills. His projects include 'Interactive Pokedex,' 'CheeseMath,' and 'Secrets & Environments,' which showcase his ability to create interactive web applications using frontend technologies like HTML, CSS, and JavaScript. Additionally, his experience with AWS services such as DynamoDB, S3, and AWS Amplify indicates proficiency in the backend and cloud infrastructure required for robust software development. His recent projects also emphasize his capabilities with AWS Lambda, further validating his strength in building scalable and performant web applications."
**Classification: OVERCLAIM**
- "extensive projects" — overclaim.
- "scalable and performant web applications" — overclaim.
- "robust software development" — overclaim.
**VERDICT: FACTUALLY WRONG (overclaim).**

### 13. "Does he know React?"
**A:** "His AWS internship capstone project involved using React for a web application's frontend components."
**Classification: WRONG_PROJECT_ASSOCIATION + FABRICATION**
- AWS capstone tech list: AWS Lambda, DynamoDB, S3, AWS Amplify. React is NOT in the capstone tech list.
- React is in his skills, but no specific project in knowledge uses React.
**VERDICT: FACTUALLY WRONG. Validator false accept.**

### 14. "What about Node.js?"
**A:** "His AWS internship capstone used Node.js as part of a serverless backend for the interactive Pokedex application."
**Classification: WRONG_PROJECT_ASSOCIATION + FABRICATION**
- AWS capstone did NOT use Node.js (not in tech list).
- AWS capstone is NOT the Interactive Pokedex.
- Two wrong relationships in one sentence.
**VERDICT: FACTUALLY WRONG. Validator false accept.**

### 15. "What's he best at?"
**A:** "He is best at JavaScript, HTML, and CSS, skills he has developed through his previous work experience and ongoing learning. These languages are fundamental to front-end web development. His expertise in these areas makes him proficient in creating dynamic, interactive websites, which is crucial for developing web-based applications and services."
**Classification: OVERCLAIM**
- "expertise" — overclaim.
- "previous work experience" — vague, but his paid work is mostly not coding (Army, roofing, animal care, case management). Mild misattribution.
**VERDICT: FACTUALLY WRONG (overclaim).**

### 16. "Explain ProjectHub like I'm not technical."
**A:** "ProjectHub is like a digital playground where you can create fun learning activities. Think of it as a place where kids gather to build games, solve puzzles, or learn new things together. Just like how you might use blocks to make a tower, ProjectHub lets people use code and tools to create interactive content online. It's all about making learning fun and engaging!"
**Classification: WRONG_ENTITY_ASSOCIATION**
- ProjectHub is NOT a digital playground for kids. It is an AI recruiter assistant.
- Completely wrong description.
**VERDICT: FACTUALLY WRONG. Validator false accept.**

### 17. "Okay now explain it technically."
**A:** "When explaining technical concepts, especially complex ones like programming languages, frameworks, or tools, we often need to break down the details into smaller, more manageable parts. For example, when discussing JavaScript, we can break it down further into its core components such as variables, functions, DOM manipulation, etc., making it easier to understand how these elements interact within a web application. Similarly, when discussing AWS services, we can go beyond just mentioning Amazon DynamoDB and explain what it does under the hood..."
**Classification: NON_ANSWER**
- Doesn't explain ProjectHub at all. Talks about explaining technical concepts generally.
**VERDICT: NON_ANSWER (not factually wrong, but not answering).**

### 18. "Why did he build it that way?"
**A:** "He built it that way because he wanted to demonstrate his skills and learning process while working on his personal project. It's common for developers to experiment with different technologies and frameworks to improve their understanding and problem-solving abilities..."
**Classification: GENERIC + UNSUPPORTED_RELATIONSHIP**
- No specific reason is in knowledge. Answer is generic speculation.
**VERDICT: NON_ANSWER (generic speculation).**

### 19. "Tell me about Bradley."
**A:** "Bradley Matera is a software engineer with expertise in JavaScript, HTML, CSS, Jest, WebGPU, AWS Lambda, DynamoDB, S3, AWS Amplify, and AWS usage metrics. He has worked on projects such as Interactive Pokedex, CheeseMath, and Secrets & Environments. His experience includes internships with AWS, where he has utilized AWS services like DynamoDB for serverless metadata workflows and AWS Amplify for user interface development."
**Classification: OVERCLAIM**
- "expertise" — overclaim.
- "internships" (plural) — only one AWS internship.
- Otherwise mostly correct.
**VERDICT: FACTUALLY WRONG (overclaim).**

### 20. "What does he actually do?"
**A:** "Bradley Matera works as a software engineer, specializing in areas such as JavaScript, HTML, CSS, Jest, WebGPU, AWS Lambda, DynamoDB, S3, AWS Amplify, and AWS usage metrics. He has been involved in projects like Interactive Pokedex, CheeseMath, and Secrets & Environments, demonstrating his capabilities in developing web applications and services that utilize AWS tools. His role involves collaborating with cross-functional teams and contributing to the overall functioning of these projects."
**Classification: OVERCLAIM + FABRICATION**
- "specializing" — overclaim.
- "collaborating with cross-functional teams" — not in knowledge.
**VERDICT: FACTUALLY WRONG (overclaim + fabrication).**

### 21. "What's his strongest project?"
**A:** "His strongest project is likely 'Interactive Pokedex', given his expertise in web technologies and his experience working on interactive features using JavaScript, HTML, and CSS. Additionally, his involvement with AWS services suggests he has strong skills in cloud infrastructure and backend development. However, without direct information about his personal preferences or achievements, we cannot definitively state this as his strongest project."
**Classification: OVERCLAIM + INTERPRETATION**
- "expertise" — overclaim.
- This is an interpretation, which is allowed, but uses overclaim language.
- Pokedex tech (JS, HTML, CSS) is correct.
**VERDICT: BORDERLINE — interpretation is OK but overclaim language makes it unsafe.**

### 22. "What's your favorite thing he's built?"
**A:** "As a software engineer specializing in web technologies, my favorite thing he has built is likely his interactive Pokedex, which showcases Pokémon through an engaging interface. This project demonstrates his expertise in front-end web development, including the use of JavaScript, HTML, and CSS to create a visually appealing and interactive experience for users. Additionally, it showcases his proficiency with APIs and data visualization tools, such as WebGPU, which allows for the creation of high-quality graphics and animations."
**Classification: PERSONA_ERROR + WRONG_ENTITY_ASSOCIATION + OVERCLAIM**
- "As a software engineer specializing in web technologies" — Scout is speaking as if it is Bradley.
- Pokedex does NOT use WebGPU. WebGPU is in Triangle Shader Lab.
- "APIs and data visualization tools" — Pokedex is static UI, no API mentioned.
- "expertise" — overclaim.
**VERDICT: FACTUALLY WRONG (persona + wrong entity + overclaim).**

### 23. "What would you ask him if you were interviewing him?"
**A:** "Tell me about your experience working with AWS Lambda and DynamoDB to optimize serverless workflows."
**Classification: PERSONA_ERROR (mild)**
- The question itself is fine, but the persona marker flagged it.
- Content is grounded.
**VERDICT: FACTUALLY CORRECT, mild persona issue.**

### 24. "What did he use there?"
**A:** "He used AWS Lambda, S3, and CloudFront for his projects."
**Classification: FACTUALLY_CORRECT_BUT_INCOMPLETE**
- AWS internship skills include Lambda, S3, CloudFront. Correct.
- Missing DynamoDB, Amplify.
**VERDICT: FACTUALLY CORRECT (incomplete).**

### 25. "Was that AWS?"
**A:** "His AWS internship capstone project integrated AWS services such as AWS Lambda, S3, and AWS Amplify into a web application, demonstrating his understanding of cloud computing technologies and his ability to apply them in a real-world context."
**Classification: FACTUALLY_CORRECT_BUT_GENERIC**
- Lambda, S3, Amplify are all in capstone tech. Correct.
- "real-world context" is mild overclaim (it was a training/capstone, not production).
**VERDICT: MOSTLY CORRECT, mild overclaim.**

### 26. "What about the other project?"
**A:** "The other project mentioned by Bradley Matera is called 'Secrets & Environment Variables Demo.' This project involved creating different environments for web applications using AWS services such as CloudFormation and AWS Amplify. It demonstrated his expertise in serverless computing and configuration management."
**Classification: WRONG_ENTITY_ASSOCIATION + OVERCLAIM**
- Secrets & Environments Demo is a frontend security education demo (JavaScript, HTML, CSS). It does NOT use AWS CloudFormation or AWS Amplify.
- "expertise" — overclaim.
**VERDICT: FACTUALLY WRONG. Validator false accept.**

### 27. "Did he do that professionally?"
**A:** "His projects demonstrate his skills in web development and cloud services like AWS, showcasing his ability to deploy complex applications and manage scalable infrastructure."
**Classification: OVERCLAIM + NON_ANSWER**
- "deploy complex applications" — overclaim.
- "manage scalable infrastructure" — overclaim.
- Doesn't answer whether it was professional.
**VERDICT: FACTUALLY WRONG (overclaim) + non-answer.**

### 28. "So what is this thing?"
**A:** "It seems there might be a typo or confusion in your question. Could you please clarify what exactly you're asking about this thing?"
**Classification: NON_ANSWER**
- Doesn't answer, but not factually wrong.
**VERDICT: NON_ANSWER (clarification request).**

### 29. "What's the cool part?"
**A:** "The cool part about your projects, Bradley, is that they demonstrate both technical skills and creativity. For instance, your Interactive Pokedex uses React to create an engaging Pokémon game, showcasing your proficiency in JavaScript and HTML/CSS. Meanwhile, CheeseMath is an educational tool that makes learning math fun with interactive puzzles, demonstrating your expertise in both front-end development and user experience design. Your projects also highlight your ability to leverage AWS services like AWS Lambda, DynamoDB, and S3..."
**Classification: PERSONA_ERROR + WRONG_ENTITY_ASSOCIATION + OVERCLAIM**
- "your projects, Bradley" — Scout speaking to Bradley as if Bradley is the user. Persona confusion.
- "Interactive Pokedex uses React" — WRONG. Pokedex tech is JavaScript, HTML, CSS.
- "expertise" — overclaim.
**VERDICT: FACTUALLY WRONG (persona + wrong entity + overclaim).**

### 30. "Is that actually impressive?"
**A:** "being a software engineer with skills in multiple programming languages and frameworks is impressive. His experience with AWS services like AWS Lambda, DynamoDB, S3, and AWS Amplify showcases his versatility in cloud computing services. Additionally, his projects demonstrate his ability to create interactive applications and complex systems."
**Classification: OVERCLAIM**
- "complex systems" — overclaim.
- Otherwise mostly grounded.
**VERDICT: FACTUALLY WRONG (overclaim).**

### 31. "What's he best at?" (natural category)
**A:** "He is best at using AWS services such as AWS Lambda, DynamoDB, S3, and AWS Amplify. He has expertise in JavaScript, HTML, CSS, Jest, WebGPU, and has developed projects related to AWS services. His AWS internship capstone project involved using these services within a serverless metadata workflow."
**Classification: OVERCLAIM**
- "expertise" — overclaim.
- Otherwise correct.
**VERDICT: FACTUALLY WRONG (overclaim).**

### 32. "How does he fit a junior frontend developer role requiring React and TypeScript?"
**A:** "Bradley Matera fits the requirements for a junior frontend developer role by his previous experience with React and TypeScript. Additionally, his skills in JavaScript, HTML, CSS, and Jest suggest proficiency in modern web development practices. His background in AWS services such as AWS Lambda also indicates familiarity with backend infrastructure, which is beneficial for a full-stack developer role. His experience with WebGPU further enhances his expertise in graphics technologies."
**Classification: OVERCLAIM + UNSUPPORTED_RELATIONSHIP**
- "previous experience with React and TypeScript" — React and TypeScript are in skills, but no project specifically uses them in knowledge. Mildly unsupported.
- "expertise in graphics technologies" — overclaim.
**VERDICT: FACTUALLY WRONG (overclaim + unsupported).**

### 33. "How does he fit a cloud support role requiring AWS and troubleshooting?"
**A:** "He fits a cloud support role by leveraging his expertise in AWS Lambda, DynamoDB, and other AWS services, demonstrating proficiency in cloud computing technologies essential for supporting cloud infrastructure. His previous work on AWS Amplify and AWS usage metrics also shows his ability to troubleshoot and optimize AWS environments..."
**Classification: OVERCLAIM**
- "expertise" — overclaim.
- "troubleshoot and optimize AWS environments" — he did guided troubleshooting labs, but "optimize AWS environments" is overclaim.
**VERDICT: FACTUALLY WRONG (overclaim).**

### 34. "How does he fit a full-stack role requiring Node.js and React?"
**A:** "Bradley Matera has the necessary skills to fit a full-stack role requiring Node.js and React. He has experience with these technologies and can contribute to both the front-end and back-end aspects of the project. His background in JavaScript, HTML, CSS, Jest, WebGPU, AWS Lambda, DynamoDB, and S3 demonstrates proficiency in both frontend frameworks (React) and backend services (AWS). Additionally, his experience with AWS Amplify suggests knowledge of managing serverless architectures, which is crucial for developing full-stack applications. His project experience with Interactive Pokedex and CheeseMath also indicates familiarity with handling..."
**Classification: OVERCLAIM + UNSUPPORTED_RELATIONSHIP**
- "experience with these technologies" — Node.js and React are in skills, but no project explicitly uses them in knowledge base.
- Otherwise mostly grounded in skills list.
**VERDICT: BORDERLINE — skills are listed but project-specific claims are unsupported.**

### 35. "Compare ProjectHub and CIRIS Ethical AI."
**A:** "ProjectHub and CIRIS Ethical AI are both initiatives aimed at ethical considerations in AI development. While they serve different purposes, they share some similarities in their approach to ensuring ethical AI practices. Both organizations emphasize transparency and accountability in AI systems... However, CIRIS specifically targets AI for social good by focusing on applications that have a positive impact on society, such as education and healthcare. On the other hand, ProjectHub focuses more broadly on the ethical aspects of AI, including privacy, bias, and safety."
**Classification: WRONG_ENTITY_ASSOCIATION + FABRICATION**
- ProjectHub is NOT an "ethical AI initiative." It is a recruiter assistant.
- CIRIS is NOT specifically about "AI for social good in education and healthcare."
- Both descriptions are fabricated.
**VERDICT: FACTUALLY WRONG. Validator false accept.**

### 36. "Which project is the most complex?"
**A:** "After reviewing his projects, the most complex project according to the fact is the Interactive Pokedex, which involves developing an interactive web page showcasing Pokémon with features such as animations and user interactions. This project demonstrates his skills in JavaScript, HTML, CSS, and WebGPU."
**Classification: WRONG_ENTITY_ASSOCIATION**
- Pokedex tech is JavaScript, HTML, CSS. WebGPU is NOT in Pokedex.
- WebGPU is in Triangle Shader Lab.
**VERDICT: FACTUALLY WRONG. Validator false accept.**

### 37. "What experience does he lack?"
**A:** "Bradley Matera lacks practical experience in backend development, as evidenced by his AWS Lambda project which only involves frontend elements."
**Classification: WRONG_ENTITY_ASSOCIATION + FABRICATION**
- AWS Lambda is backend/serverless. Saying it "only involves frontend elements" is wrong.
- The actual gap is DSA, not backend development.
**VERDICT: FACTUALLY WRONG. Validator false accept.**

### 38. "What should a recruiter know about gaps in his background?"
**A:** "A gap in someone's background can be an important piece of information for a recruiter. It might indicate a lack of recent experience that could affect their fit for certain roles..."
**Classification: NON_ANSWER + GENERIC**
- Doesn't mention Bradley's actual gaps (DSA, blank-file architecture).
- Generic advice about gaps.
**VERDICT: NON_ANSWER (generic).**

### 39. "He was a senior AWS engineer, right?"
**A:** "No. He was an intern, not senior."
**Classification: FACTUALLY_CORRECT**
**VERDICT: FACTUALLY CORRECT.**

### 40. "He worked at Google, right?"
**A:** "No, he did not work at Google. His experiences and projects are related to AWS and other cloud services, not Google's infrastructure. **Evidence:** 'His AWS internship capstone used DynamoDB as part of a serverless metadata workflow with Lambda, S3, and CloudFront.'"
**Classification: FACTUALLY_CORRECT**
- Note: CloudFront is in AWS internship skills, not explicitly in capstone tech list, but is in the broader skills. Mild.
**VERDICT: FACTUALLY CORRECT.**

### 41. "He was not a senior engineer, was he?"
**A:** "he was not a senior engineer. He was an intern, not senior."
**Classification: FACTUALLY_CORRECT**
**VERDICT: FACTUALLY CORRECT.**

### 42. "There is no evidence he attended MIT, right?"
**A:** "Correct, there is no evidence in the provided facts that Bradley Matera attended MIT. The only institution mentioned is AWS, which is likely related to his work experience rather than his educational background."
**Classification: FACTUALLY_CORRECT_BUT_INCOMPLETE**
- Correct about MIT.
- "The only institution mentioned is AWS" — WRONG. Full Sail University is his school. Major error.
**VERDICT: FACTUALLY WRONG (misses Full Sail).**

### 43. "Tell me about his master's degree."
**A:** "No specific information about his master's degree is provided in the facts given."
**Classification: FACTUALLY_CORRECT_BUT_GENERIC**
- Correct that no master's is in facts. Could be more direct ("He does not have a master's degree").
**VERDICT: FACTUALLY CORRECT (generic).**

### 44. "If you had to bet on him succeeding in one type of role, what would it be?"
**A:** "Based on his skills and experience, his most likely bet for success would be in the field of front-end web development, specifically using frameworks like React or Vue.js. His expertise in JavaScript, HTML, CSS, and his familiarity with modern web technologies make him well-suited for this role. Additionally, his experience with AWS services such as AWS Lambda and S3 suggests he could excel in cloud-based solutions and scalability. His background in creating interactive applications and handling data access through DynamoDB would also be valuable in this area."
**Classification: OVERCLAIM + WRONG_ENTITY_ASSOCIATION**
- "expertise" — overclaim.
- "Vue.js" — NOT in his skills or knowledge. Fabricated.
- "handling data access through DynamoDB" — he used DynamoDB in capstone, but "handling data access" is mild overclaim.
**VERDICT: FACTUALLY WRONG (overclaim + Vue.js fabrication).**

### 45. "What's the most honest thing you can tell me about him?"
**A:** "His dedication to learning and his ability to quickly adapt to new technologies demonstrate his commitment to professional development."
**Classification: FACTUALLY_CORRECT_BUT_GENERIC**
- Grounded in "learns quickly" but very generic.
**VERDICT: FACTUALLY CORRECT (generic).**

### 46. "Is he someone worth interviewing?"
**A:** "he is someone worth interviewing. Bradly Matera has extensive experience in web development, including expertise in technologies like WebGPU, AWS Lambda, and DynamoDB, which makes him valuable to discuss modern web development practices and challenges. His projects like Interactive Pokedex showcase his skills in creating interactive web applications, aligning well with the interview's focus on current web development trends. His involvement with AWS tools such as AWS Lambda and S3 indicates his understanding and practical application of cloud computing services..."
**Classification: OVERCLAIM + TYPO**
- "extensive experience" — overclaim.
- "expertise" — overclaim.
- "Bradly" — typo (minor).
**VERDICT: FACTUALLY WRONG (overclaim).**

---

## SUMMARY

| Classification | Count | % of 46 accepted |
|---|---|---|
| FACTUALLY_CORRECT (clean) | 5 (#7, #39, #40, #41, #43) | 11% |
| FACTUALLY_CORRECT_BUT_INCOMPLETE/GENERIC | 6 (#3, #8, #9, #24, #25, #45) | 13% |
| BORDERLINE (interpretation OK, overclaim language) | 2 (#21, #34) | 4% |
| FACTUALLY_CORRECT with mild issue | 1 (#23 persona) | 2% |
| NON_ANSWER (clarification/generic) | 4 (#17, #18, #28, #38) | 9% |
| FACTUALLY_WRONG (overclaim) | 11 (#2, #10, #11, #12, #15, #19, #20, #27, #30, #31, #33, #46) | 24% |
| FACTUALLY_WRONG (wrong entity/project association) | 9 (#1, #4, #6, #13, #14, #16, #26, #29, #35, #36, #37, #42, #44) | 28% |
| PERSONA_ERROR | 2 (#22, #29) | 4% |

**REAL BASELINE:**

- **Actually factually correct (clean or mostly clean): 12/46 (26%)**
- **Factually wrong (overclaim or wrong relationship): 28/46 (61%)**
- **Non-answers: 4/46 (9%)**
- **Borderline: 2/46 (4%)**

**The validator accepted 46 answers. Only ~12 are actually factually correct.**

**The 68% "accepted" rate was actually a ~18% factually-correct rate (12/68).**

## ROOT CAUSE

The validator checks:
1. Are the entities/terms known? (yes — all words exist somewhere)
2. Are there unsupported numbers? (no numbers in most)
3. Are there forbidden overclaim phrases? (regex misses many variants like "extensive experience", "expertise in", "adept at", "specializing in", "proficiency in", "demonstrates his expertise")
4. Are there persona issues? (catches some, misses "As a software engineer specializing...")

The validator does NOT check:
1. **Does the evidence support THIS RELATIONSHIP between these entities?**
   - "ProjectHub was built at Amazon" — ProjectHub exists, Amazon exists, but the relationship is false.
   - "Pokedex uses React" — Pokedex exists, React exists, but the relationship is false.
   - "AWS capstone is the Interactive Pokedex" — both exist, relationship is false.
   - "Secrets & Environments uses CloudFormation" — both exist, relationship is false.
2. **Overclaim variants beyond the regex list**
   - "extensive experience", "expertise in", "specializing in", "adept at", "proficiency in", "demonstrates his expertise", "complex systems", "scalable infrastructure"
3. **Fabricated entities not in knowledge**
   - "Vue.js" — not in skills, not in any project
4. **Missing key facts**
   - "The only institution mentioned is AWS" — misses Full Sail University entirely

The core problem: **the validator treats facts as a bag of words, not as relationships with provenance.**
