FROM node:24-bookworm-slim
WORKDIR /app
ENV HOST=0.0.0.0 PORT=8080 NODE_ENV=production
COPY --chown=node:node ["index.html", "styles.css", "app.js", "rules.js", "online.js", "voice.js", "music.js", "server.cjs", "multiplayer.cjs", "./"]
COPY --chown=node:node ["卡牌/", "./卡牌/"]
COPY --chown=node:node ["数据/牌桌数据.js", "./数据/牌桌数据.js"]
COPY --chown=node:node ["录音/播报素材.js", "录音/胜利语音.js", "录音/胜利配图.jpg", "./录音/"]
USER node
EXPOSE 8080
CMD ["node", "server.cjs"]
