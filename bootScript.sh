#!/usr/bin/env bash
curl -sL https://deb.nodesource.com/setup_8.x | sudo -E bash -
sudo apt install nodejs
yes | sudo apt-get install git
yes | sudo apt-get install build-essential
git clone https://github.com/SOM-Research/gadolinium
git clone https://github.com/baskaran-md/gcp-metadata
INSTANCENAME=$(./gcp-metadata/gcp-metadata -n | cut -d ':' -f 2 | cut -d ' ' -f 2)
REGION=$(./gcp-metadata/gcp-metadata -z | cut -d ':' -f 2 | cut -d ' ' -f 2)
cd gadolinium
npm install
node index.js "slave" "$REGION" "$INSTANCENAME"
