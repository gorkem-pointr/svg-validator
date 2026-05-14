FROM nginx:1.27-alpine

COPY deployment/nginx.conf /etc/nginx/conf.d/default.conf

COPY index.html /usr/share/nginx/html/
COPY styles.css /usr/share/nginx/html/
COPY alignment.css /usr/share/nginx/html/
COPY api.js /usr/share/nginx/html/
COPY alignment.js /usr/share/nginx/html/
COPY validator.js /usr/share/nginx/html/
COPY VERSION /usr/share/nginx/html/

EXPOSE 80
