# Polaris · High School Subject Exploration

[中文说明](README.md) · [Open Polaris](https://yusheng266186-beep.github.io/beichen/) · [Release history](CHANGELOG.md)

Polaris helps students reflect on their experience of school subjects, their interests, and realistic subject combinations. The main project supports two modes of conversation and produces a visual star-map report. [Polaris v3](https://github.com/yusheng266186-beep/beichen-codex) is a separately deployed branch of the project family.

## Use the conversation

- In the reflective mode, describe specific experiences and how they felt. In the guided mode, work through the subjects and combinations you want to compare.
- Read the star map as a record of the conversation. Use it to identify what you still want to ask a teacher, try in a class, or verify in the current school plan.
- The interaction is in Chinese. Current subject rules and availability should be checked with the school and official sources.

## Front end, relay, and maintainer checks

The static application is hosted on GitHub Pages. Model requests use a dedicated serverless relay. Provider credentials are configured in the service environment. The source includes an example environment file and [beginner deployment guide](beginner-deploy.md).

~~~bash
npm ci
npm run verify
~~~

Use Node.js 18 or later as specified by the repository. Review [model adaptation](MODEL-ADAPTATION.md) before altering provider profiles, request handling, or the conversation flow. The Chinese README records the historical Redis test, the current maintenance workflow, and the local and cloud boundaries. Check the deployed relay contract and run with demo prompts before processing student conversations.
