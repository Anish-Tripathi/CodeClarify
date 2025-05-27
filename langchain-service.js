// Make LangChainCodeExplainer available globally for content scripts
window.LangChainCodeExplainer = class LangChainCodeExplainer {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = "https://api.openai.com/v1/chat/completions";
    this.conversationHistory = [];
    this.maxHistoryLength = 10;
  }

  // Detect programming language from code snippet
  detectLanguage(code) {
    const languagePatterns = {
      javascript: [
        /function\s+\w+/,
        /const\s+\w+\s*=/,
        /let\s+\w+/,
        /var\s+\w+/,
        /=>\s*{/,
        /console\.log/,
      ],
      python: [
        /def\s+\w+/,
        /import\s+\w+/,
        /from\s+\w+\s+import/,
        /print\(/,
        /if\s+__name__\s*==\s*['"]\s*__main__\s*['"]/,
        /:\s*$/m,
      ],
      java: [
        /public\s+class/,
        /private\s+\w+/,
        /public\s+static\s+void\s+main/,
        /System\.out\.print/,
        /import\s+java\./,
      ],
      cpp: [
        /#include\s*</,
        /std::/,
        /cout\s*<</,
        /int\s+main\s*\(/,
        /using\s+namespace/,
      ],
      csharp: [
        /using\s+System/,
        /public\s+class/,
        /Console\.Write/,
        /namespace\s+\w+/,
        /public\s+static\s+void\s+Main/,
      ],
      php: [/<\?php/, /\$\w+/, /echo\s+/, /function\s+\w+\s*\(/, /class\s+\w+/],
      ruby: [/def\s+\w+/, /puts\s+/, /class\s+\w+/, /require\s+/, /end$/m],
      go: [
        /package\s+\w+/,
        /func\s+\w+/,
        /import\s+/,
        /fmt\.Print/,
        /var\s+\w+\s+\w+/,
      ],
      rust: [
        /fn\s+\w+/,
        /let\s+mut/,
        /println!/,
        /use\s+std::/,
        /struct\s+\w+/,
      ],
      sql: [
        /SELECT\s+/,
        /FROM\s+/,
        /WHERE\s+/,
        /INSERT\s+INTO/,
        /UPDATE\s+/,
        /CREATE\s+TABLE/i,
      ],
      html: [/<html/, /<div/, /<script/, /<style/, /<body/],
      css: [/\{\s*[\w-]+\s*:/, /@media/, /\.[\w-]+\s*{/, /#[\w-]+\s*{/],
    };

    for (const [lang, patterns] of Object.entries(languagePatterns)) {
      if (patterns.some((pattern) => pattern.test(code))) {
        return lang;
      }
    }
    return "unknown";
  }

  // Create contextual prompt using LangChain-style templating
  createPromptTemplate(code, language, context = "", followUpQuestion = "") {
    const baseTemplate = `You are an expert programming assistant with deep knowledge of software development, algorithms, and best practices. Your goal is to provide clear, educational explanations that help users understand code better.

CODE TO ANALYZE:
Language: ${language}
Context: ${context || "No additional context provided"}

\`\`\`${language}
${code}
\`\`\`

${followUpQuestion ? `SPECIFIC QUESTION: ${followUpQuestion}` : ""}

INSTRUCTIONS:
1. Provide a clear, beginner-friendly explanation of what this code does
2. Break down complex parts line-by-line if necessary
3. Explain the purpose and reasoning behind key constructs
4. Identify any potential issues, inefficiencies, or improvements
5. Suggest best practices or alternative approaches where relevant
6. If the code appears incomplete, mention what might be missing

FORMAT YOUR RESPONSE AS:
**Summary:** Brief overview of what the code does
**Detailed Explanation:** Step-by-step breakdown
**Key Concepts:** Important programming concepts demonstrated
**Potential Issues:** Any problems or concerns (if applicable)
**Improvements:** Suggestions for better code (if applicable)
**Related Topics:** Concepts the user might want to learn more about`;

    return baseTemplate;
  }

  // Generate explanation using GPT API
  async explainCode(
    code,
    language = null,
    context = "",
    followUpQuestion = ""
  ) {
    try {
      if (!language) {
        language = this.detectLanguage(code);
      }

      const prompt = this.createPromptTemplate(
        code,
        language,
        context,
        followUpQuestion
      );

      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4",
          messages: [
            {
              role: "system",
              content:
                "You are an expert programming tutor who explains code in a clear, educational manner.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          max_tokens: 1500,
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }

      const data = await response.json();
      const explanation = data.choices[0].message.content;

      // Add to conversation history for context
      this.addToHistory(code, explanation, language);

      return {
        explanation,
        language,
        detectedLanguage:
          language === "unknown" ? "Could not detect language" : language,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error("Error explaining code:", error);
      throw new Error(
        "Failed to generate explanation. Please check your API key and try again."
      );
    }
  }

  // Handle follow-up questions with context
  async askFollowUp(question, originalCode, originalExplanation) {
    const contextPrompt = `Previous code analysis:
CODE: ${originalCode}
PREVIOUS EXPLANATION: ${originalExplanation}

FOLLOW-UP QUESTION: ${question}

Please answer the follow-up question based on the code and previous context.`;

    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4",
          messages: [
            {
              role: "system",
              content:
                "You are an expert programming tutor answering follow-up questions about code.",
            },
            {
              role: "user",
              content: contextPrompt,
            },
          ],
          max_tokens: 800,
          temperature: 0.3,
        }),
      });

      const data = await response.json();
      return data.choices[0].message.content;
    } catch (error) {
      console.error("Error with follow-up question:", error);
      throw new Error("Failed to answer follow-up question.");
    }
  }

  // Manage conversation history for context
  addToHistory(code, explanation, language) {
    this.conversationHistory.push({
      code,
      explanation,
      language,
      timestamp: Date.now(),
    });

    // Keep history manageable
    if (this.conversationHistory.length > this.maxHistoryLength) {
      this.conversationHistory.shift();
    }
  }

  // Get context from surrounding code (if available)
  extractContext(element) {
    let context = "";

    // Try to get parent code block
    const codeBlock = element.closest(
      "pre, .highlight, .code-block, .sourceCode"
    );
    if (codeBlock) {
      const fullCode = codeBlock.textContent;
      if (fullCode.length > 1000) {
        context =
          fullCode.substring(0, 500) +
          "...[truncated]..." +
          fullCode.substring(fullCode.length - 500);
      } else {
        context = fullCode;
      }
    }

    // Try to get filename or title from nearby elements
    const titleElement = document.querySelector(
      "h1, h2, h3, .filename, .file-header"
    );
    if (titleElement) {
      context = `File/Section: ${titleElement.textContent.trim()}\n\n${context}`;
    }

    return context;
  }
};
