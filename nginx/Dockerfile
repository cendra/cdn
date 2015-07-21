FROM ubuntu:14.04
# Install Nginx.
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y software-properties-common wget
RUN DEBIAN_FRONTEND=noninteractive add-apt-repository -y ppa:nginx/stable
RUN DEBIAN_FRONTEND=noninteractive apt-get update
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y nginx-full
RUN rm -rf /var/lib/apt/lists/* && \
  chown -R www-data:www-data /var/lib/nginx && \
  mkdir /etc/nginx/geoip

WORKDIR /etc/nginx/geoip

RUN \
  wget -N http://geolite.maxmind.com/download/geoip/database/GeoLiteCountry/GeoIP.dat.gz && \
  gunzip GeoIP.dat.gz && \
#  rm GeoIP.dat.gz && \
  wget -N http://geolite.maxmind.com/download/geoip/database/GeoLiteCity.dat.gz && \
  gunzip GeoLiteCity.dat.gz
#  rm GeoLiteCity.dat.gz

COPY nginx.conf /etc/nginx/nginx.conf

# Define mountable directories.
VOLUME ["/etc/nginx/sites-enabled", "/etc/nginx/certs", "/etc/nginx/conf.d", "/var/log/nginx", "/var/www/html", "/var/cache/nginx", "/etc/nginx/geoip"]

# Define working directory.
WORKDIR /etc/nginx

# Define default command.
CMD ["nginx", "-g", "daemon off;"]

# Expose ports.
EXPOSE 80
EXPOSE 443
