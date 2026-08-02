# Ruby tooling for iOS builds and store automation.
#
# NOTE: macOS ships Ruby 2.6, which modern CocoaPods and fastlane no longer
# support. Install a managed Ruby (rbenv, mise, or `brew install ruby`) matching
# .ruby-version before running `bundle install`. The Homebrew `cocoapods`
# formula vendors its own Ruby and works without this Gemfile; the Gemfile
# exists so CI and every developer resolve identical gem versions.

source 'https://rubygems.org'

ruby '>= 3.2.0'

gem 'cocoapods', '~> 1.17'
gem 'fastlane', '~> 2.230'

# Xcode 15+ requires a newer xcodeproj than some transitive pins resolve to.
gem 'xcodeproj', '>= 1.25'

plugins_path = File.join(File.dirname(__FILE__), 'fastlane', 'Pluginfile')
eval_gemfile(plugins_path) if File.exist?(plugins_path)
